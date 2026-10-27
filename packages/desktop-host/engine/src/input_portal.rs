//! Keyboard through the session portal's RemoteDesktop interface.
//!
//! Chosen only when the portal itself advertises a keyboard device, so no
//! host-wide `uinput` device is opened. The portal session is the engine's own:
//! it carries only the keycodes this session sends, it listens to nothing (this
//! is the injection interface, not InputCapture, which would read the host
//! seat), and it is closed when the adapter is dropped with the session.

use anyhow::{Context, Result};
use ashpd::desktop::remote_desktop::{DeviceType, KeyState, RemoteDesktop};
use ashpd::desktop::PersistMode;
use tokio::sync::mpsc;

pub struct PortalKeys(mpsc::UnboundedSender<(i32, KeyState)>);

/// Whether the portal offers a keyboard. Reads one property; creates no
/// session and cannot prompt.
pub async fn advertised() -> bool {
    match RemoteDesktop::new().await {
        Ok(proxy) => proxy
            .available_device_types()
            .await
            .is_ok_and(|types| types.contains(DeviceType::Keyboard)),
        Err(_) => false,
    }
}

/// [`advertised`] for the synchronous capabilities report. Inside the serving
/// runtime it runs there, so ashpd's cached bus connection lives on that
/// runtime; the one-shot CLI has none and builds a throwaway. A silent bus
/// counts as no keyboard.
pub fn advertised_blocking() -> bool {
    let probe = async {
        tokio::time::timeout(std::time::Duration::from_secs(2), advertised())
            .await
            .unwrap_or(false)
    };
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => tokio::task::block_in_place(|| handle.block_on(probe)),
        Err(_) => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .is_ok_and(|runtime| runtime.block_on(probe)),
    }
}

/// Open a keyboard-only RemoteDesktop session. Keys are applied in send order
/// by one task, which closes the portal session when the adapter is dropped.
pub async fn open() -> Result<PortalKeys> {
    anyhow::ensure!(advertised().await, "the portal offers no RemoteDesktop keyboard");
    let proxy = RemoteDesktop::new().await?;
    let session = proxy
        .create_session()
        .await
        .context("RemoteDesktop.CreateSession failed")?;
    proxy
        .select_devices(&session, DeviceType::Keyboard.into(), None, PersistMode::DoNot)
        .await
        .context("RemoteDesktop.SelectDevices failed")?
        .response()
        .context("RemoteDesktop.SelectDevices was cancelled")?;
    let granted = proxy
        .start(&session, None)
        .await
        .context("RemoteDesktop.Start failed")?
        .response()
        .context("keyboard access was not granted")?;
    anyhow::ensure!(
        granted.devices().contains(DeviceType::Keyboard),
        "the portal did not grant the keyboard"
    );

    let (keys, mut queue) = mpsc::unbounded_channel::<(i32, KeyState)>();
    tokio::spawn(async move {
        while let Some((code, state)) = queue.recv().await {
            if let Err(error) = proxy.notify_keyboard_keycode(&session, code, state).await {
                log::warn!("portal keyboard: key {code} refused: {error}");
            }
        }
        let _ = session.close().await;
    });
    Ok(PortalKeys(keys))
}

impl PortalKeys {
    /// `code` is an evdev key code, the portal's own vocabulary.
    pub fn key(&self, code: i16, down: bool) -> Result<()> {
        let state = if down { KeyState::Pressed } else { KeyState::Released };
        self.0
            .send((code as i32, state))
            .map_err(|_| anyhow::anyhow!("the portal keyboard session has ended"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
    use zbus::zvariant::{ObjectPath, OwnedValue, Value};
    use zbus::{connection::Builder, interface, Connection};

    type Log = Arc<Mutex<Vec<String>>>;

    struct Bus(Child);

    impl Drop for Bus {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    struct MockSession(Log);

    #[interface(name = "org.freedesktop.portal.Session")]
    impl MockSession {
        fn close(&self) {
            self.0.lock().unwrap().push("close".into());
        }
    }

    /// A RemoteDesktop portal that grants what `devices` says and records
    /// every call, the way a compositor's portal would.
    struct MockPortal {
        devices: Arc<AtomicU32>,
        log: Log,
    }

    impl MockPortal {
        fn token(options: &HashMap<String, OwnedValue>, key: &str) -> String {
            String::try_from(options[key].try_clone().unwrap()).unwrap()
        }

        async fn respond(
            connection: &Connection,
            sender: &str,
            options: &HashMap<String, OwnedValue>,
            results: HashMap<&str, Value<'_>>,
        ) -> ObjectPath<'static> {
            let path = ObjectPath::try_from(format!(
                "/org/freedesktop/portal/desktop/request/{}/{}",
                sender.trim_start_matches(':').replace('.', "_"),
                Self::token(options, "handle_token")
            ))
            .unwrap();
            connection
                .emit_signal(
                    None::<&str>,
                    &path,
                    "org.freedesktop.portal.Request",
                    "Response",
                    &(0u32, results),
                )
                .await
                .unwrap();
            path
        }
    }

    #[interface(name = "org.freedesktop.portal.RemoteDesktop")]
    impl MockPortal {
        #[zbus(property)]
        fn available_device_types(&self) -> u32 {
            self.devices.load(Ordering::SeqCst)
        }

        #[zbus(property, name = "version")]
        fn version(&self) -> u32 {
            2
        }

        async fn create_session(
            &self,
            #[zbus(connection)] connection: &Connection,
            #[zbus(header)] header: zbus::message::Header<'_>,
            options: HashMap<String, OwnedValue>,
        ) -> ObjectPath<'static> {
            let sender = header.sender().unwrap().to_string();
            let session = format!(
                "/org/freedesktop/portal/desktop/session/{}/{}",
                sender.trim_start_matches(':').replace('.', "_"),
                Self::token(&options, "session_handle_token")
            );
            connection
                .object_server()
                .at(session.as_str(), MockSession(self.log.clone()))
                .await
                .unwrap();
            let results = HashMap::from([("session_handle", Value::from(session))]);
            Self::respond(connection, &sender, &options, results).await
        }

        async fn select_devices(
            &self,
            #[zbus(connection)] connection: &Connection,
            #[zbus(header)] header: zbus::message::Header<'_>,
            _session: ObjectPath<'_>,
            options: HashMap<String, OwnedValue>,
        ) -> ObjectPath<'static> {
            let sender = header.sender().unwrap().to_string();
            Self::respond(connection, &sender, &options, HashMap::new()).await
        }

        async fn start(
            &self,
            #[zbus(connection)] connection: &Connection,
            #[zbus(header)] header: zbus::message::Header<'_>,
            _session: ObjectPath<'_>,
            _parent: String,
            options: HashMap<String, OwnedValue>,
        ) -> ObjectPath<'static> {
            let sender = header.sender().unwrap().to_string();
            let results = HashMap::from([("devices", Value::from(self.devices.load(Ordering::SeqCst)))]);
            Self::respond(connection, &sender, &options, results).await
        }

        fn notify_keyboard_keycode(
            &self,
            _session: ObjectPath<'_>,
            _options: HashMap<String, OwnedValue>,
            keycode: i32,
            state: u32,
        ) {
            self.log.lock().unwrap().push(format!("key {keycode} {state}"));
        }
    }

    async fn serve(devices: Arc<AtomicU32>) -> (Bus, Connection, Log) {
        let mut daemon = Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--print-address=1"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("dbus-daemon");
        let mut address = String::new();
        std::io::BufRead::read_line(
            &mut std::io::BufReader::new(daemon.stdout.take().unwrap()),
            &mut address,
        )
        .unwrap();
        let bus = Bus(daemon);
        let log = Log::default();
        let connection = Builder::address(address.trim())
            .unwrap()
            .name("org.freedesktop.portal.Desktop")
            .unwrap()
            .serve_at(
                "/org/freedesktop/portal/desktop",
                MockPortal { devices, log: log.clone() },
            )
            .unwrap()
            .build()
            .await
            .unwrap();
        // The proxies read the session bus from the environment.
        std::env::set_var("DBUS_SESSION_BUS_ADDRESS", address.trim());
        (bus, connection, log)
    }

    /// ashpd caches its session-bus connection per process, so the scenario
    /// runs in a child process of its own rather than beside the other portal
    /// test.
    #[test]
    fn keys_reach_the_portal_in_order_and_the_session_closes() {
        if std::env::var_os("DESKLINK_PORTAL_MOCK_CHILD").is_none() {
            let status = Command::new(std::env::current_exe().unwrap())
                .args(["--nocapture", "--exact", "input_portal::tests::keys_reach_the_portal_in_order_and_the_session_closes"])
                .env("DESKLINK_PORTAL_MOCK_CHILD", "1")
                .status()
                .unwrap();
            assert!(status.success());
            return;
        }
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(scenario());
    }

    /// What the capabilities report selects, as `desklink-host capabilities` prints it.
    async fn mechanism() -> String {
        let input = crate::session::capabilities()["input"].clone();
        println!("capabilities input: {input}");
        input["mechanism"].to_string()
    }

    /// Keys sent through the adapter reach the portal in order, and dropping
    /// the adapter closes the portal session. A portal that offers no keyboard
    /// is not selected, so the caller falls back to uinput.
    async fn scenario() {
        let devices = Arc::new(AtomicU32::new(2));
        let (_bus, _service, log) = serve(devices.clone()).await;
        assert!(!advertised().await);
        assert!(open().await.is_err());
        assert!(log.lock().unwrap().is_empty());
        assert_eq!(mechanism().await, "\"inputtino/uinput\"");

        devices.store(1, Ordering::SeqCst);
        assert!(advertised().await);
        assert_eq!(mechanism().await, "\"portal-remotedesktop\"");
        let keys = open().await.expect("keyboard session");
        // No host-wide virtual device while the portal carries the keys.
        for fd in std::fs::read_dir("/proc/self/fd").unwrap().flatten() {
            let target = std::fs::read_link(fd.path()).unwrap_or_default();
            assert!(!target.starts_with("/dev/uinput"), "uinput open: {target:?}");
        }
        for (code, down) in [(35, true), (35, false), (30, true), (30, false)] {
            keys.key(code, down).unwrap();
        }
        drop(keys);
        for _ in 0..100 {
            if log.lock().unwrap().last().is_some_and(|last| last == "close") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(
            *log.lock().unwrap(),
            ["key 35 1", "key 35 0", "key 30 1", "key 30 0", "close"]
        );
    }
}
