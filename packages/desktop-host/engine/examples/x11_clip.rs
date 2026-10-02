//! Independent selection-owner/readback fixture; run only on an owned lab display.
#[cfg(target_os = "linux")]
fn main() -> anyhow::Result<()> {
    use anyhow::{bail, ensure};
    use std::io::Read;
    use std::time::{Duration, Instant};
    use x11rb::connection::Connection;
    use x11rb::protocol::{xproto::*, Event};
    use x11rb::wrapper::ConnectionExt as _;

    let display = std::env::var("DISPLAY")?;
    let (conn, screen) = x11rb::connect(Some(&display))?;
    let window = conn.generate_id()?;
    conn.create_window(
        0,
        window,
        conn.setup().roots[screen].root,
        0,
        0,
        1,
        1,
        0,
        WindowClass::INPUT_ONLY,
        0,
        &CreateWindowAux::new(),
    )?
    .check()?;
    let atom =
        |name: &[u8]| -> anyhow::Result<u32> { Ok(conn.intern_atom(false, name)?.reply()?.atom) };
    let clipboard = atom(b"CLIPBOARD")?;
    let utf8 = atom(b"UTF8_STRING")?;
    let property = atom(b"LAB_CLIPBOARD")?;
    let mode = std::env::args().nth(1).unwrap_or_default();
    if mode == "get" {
        let target = atom(
            std::env::args()
                .nth(2)
                .unwrap_or(String::from("UTF8_STRING"))
                .as_bytes(),
        )?;
        ensure!(
            conn.get_selection_owner(clipboard)?.reply()?.owner != 0,
            "no selection owner"
        );
        conn.convert_selection(window, clipboard, target, property, x11rb::CURRENT_TIME)?;
        conn.flush()?;
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(Event::SelectionNotify(notify)) = conn.poll_for_event()? {
                ensure!(notify.property != 0, "target refused");
                let value = conn
                    .get_property(true, window, property, AtomEnum::ANY, 0, 100_000)?
                    .reply()?;
                ensure!(value.bytes_after == 0, "fixture read bound exceeded");
                if value.type_ == utf8 && value.format == 8 {
                    print!("{}", std::str::from_utf8(&value.value)?);
                } else {
                    ensure!(
                        value.type_ == AtomEnum::ATOM.into(),
                        "unexpected selection type"
                    );
                    for atom in value
                        .value32()
                        .ok_or_else(|| anyhow::anyhow!("not atoms"))?
                    {
                        println!(
                            "{}",
                            String::from_utf8(conn.get_atom_name(atom)?.reply()?.name)?
                        );
                    }
                }
                return Ok(());
            }
            ensure!(Instant::now() < deadline, "selection timeout");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    ensure!(
        ["set", "incr", "silent"].contains(&mode.as_str()),
        "use set|get|incr|silent"
    );
    let mut text = String::new();
    std::io::stdin().take(400_001).read_to_string(&mut text)?;
    ensure!(text.len() <= 400_000, "fixture payload bound");
    let incr = atom(b"INCR")?;
    conn.set_selection_owner(window, clipboard, x11rb::CURRENT_TIME)?
        .check()?;
    ensure!(
        conn.get_selection_owner(clipboard)?.reply()?.owner == window,
        "ownership refused"
    );
    println!("owner={window} display={display}");
    loop {
        match conn.wait_for_event()? {
            Event::SelectionClear(_) => return Ok(()),
            Event::SelectionRequest(request) => {
                if mode == "silent" {
                    continue;
                }
                let property = if request.property == 0 {
                    request.target
                } else {
                    request.property
                };
                let accepted = request.target == utf8;
                if accepted {
                    if mode == "incr" {
                        conn.change_property32(
                            PropMode::REPLACE,
                            request.requestor,
                            property,
                            incr,
                            &[300_000],
                        )?
                        .check()?;
                    } else {
                        conn.change_property8(
                            PropMode::REPLACE,
                            request.requestor,
                            property,
                            utf8,
                            text.as_bytes(),
                        )?
                        .check()?;
                    }
                }
                conn.send_event(
                    false,
                    request.requestor,
                    EventMask::NO_EVENT,
                    SelectionNotifyEvent {
                        response_type: SELECTION_NOTIFY_EVENT,
                        sequence: 0,
                        time: request.time,
                        requestor: request.requestor,
                        selection: clipboard,
                        target: request.target,
                        property: if accepted { property } else { 0 },
                    },
                )?;
                conn.flush()?;
            }
            Event::Error(error) => bail!("selection error: {error:?}"),
            _ => {}
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("X11 clipboard fixture is Linux-only");
}
