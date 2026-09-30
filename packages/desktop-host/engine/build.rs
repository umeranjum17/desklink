//! Native dependencies of the engine.
//!
//! The Linux build compiles its native adapters from local sources and links
//! system libraries for desktop overlays — no prebuilt binary is fetched at
//! build time, and nothing is installed:
//!
//! * libvpx (BSD-3-Clause) — VP9 encode, through `native/vpx_shim.c` so the
//!   versioned encoder config struct is laid out by a C compiler.
//! * inputtino (MIT, vendored under `vendor/`) — virtual mouse and keyboard
//!   over `uinput`/`libevdev`, built by its own CMake project into a static
//!   library and called through its documented C API.
//!
//! H.264 encoding adds no link-time dependency: NVENC and VA-API are loaded with
//! `dlopen` from the machine's driver at run time, compiled against vendored
//! MIT headers (`vendor/nv-codec-headers`, `vendor/libva`); openh264 is Cisco's
//! prebuilt library, fetched by the engine at run time (see `src/h264.rs`). The
//! macOS build links the VideoToolbox system framework.
//!
//! macOS builds only the libvpx shim; ScreenCaptureKit, Quartz input and
//! AppKit clipboard use native frameworks. Linux runtime input access is still
//! checked through `/dev/uinput`.
//!
//! `DESKLINK_VPX_STATIC_DIR` names a libvpx install prefix (`include/`, `lib/`)
//! to link statically instead. The prebuilt engine uses it, because libvpx's
//! soname changes with every major release and a distributed executable must not
//! depend on whichever one a given distribution ships.

use std::path::{Path, PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rustc-check-cfg=cfg(desklink_vpx)");
    println!("cargo:rustc-check-cfg=cfg(desklink_macos_cli)");
    println!("cargo:rerun-if-changed=native/vpx_shim.c");
    println!("cargo:rerun-if-changed=native/nvenc_shim.c");
    println!("cargo:rerun-if-changed=native/vaapi_shim.c");
    println!("cargo:rerun-if-changed=native/vt_shim.c");
    println!("cargo:rerun-if-changed=native/inputtino_shim.cpp");
    println!("cargo:rerun-if-changed=native/mac_stream.mm");
    println!("cargo:rerun-if-changed=native/agent_overlay_mac.m");
    println!("cargo:rerun-if-changed=native/agent_overlay_x11.c");
    println!("cargo:rerun-if-changed=native/agent_overlay_wayland.c");
    println!("cargo:rerun-if-changed=Info.plist");
    println!("cargo:rerun-if-changed=vendor/inputtino/src/uinput/include/inputtino/keyboard.hpp");
    println!("cargo:rerun-if-changed=vendor/inputtino/include/inputtino/input.h");
    println!("cargo:rerun-if-changed=vendor/inputtino/CMakeLists.txt");

    println!("cargo:rerun-if-env-changed=DESKLINK_VPX_STATIC_DIR");
    println!("cargo:rerun-if-env-changed=DESKLINK_MACOS_CLI");

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "windows" {
        if let Some(prefix) = std::env::var_os("DESKLINK_VPX_STATIC_DIR").map(PathBuf::from) {
            if std::env::var("CARGO_CFG_TARGET_ENV")? != "msvc"
                || std::env::var("CARGO_CFG_TARGET_ARCH")? != "x86_64"
            {
                return Err("Windows libvpx requires x86_64-pc-windows-msvc".into());
            }
            if !std::env::var("CARGO_CFG_TARGET_FEATURE")?
                .split(',')
                .any(|f| f == "crt-static")
            {
                return Err(
                    "Windows static libvpx requires RUSTFLAGS=-Ctarget-feature=+crt-static (/MT)"
                        .into(),
                );
            }
            if !prefix.join("include/vpx/vp8cx.h").is_file()
                || !prefix.join("lib/vpx.lib").is_file()
            {
                return Err(
                    "DESKLINK_VPX_STATIC_DIR must contain include/vpx/vp8cx.h and lib/vpx.lib"
                        .into(),
                );
            }
            cc::Build::new()
                .file("native/vpx_shim.c")
                .include(prefix.join("include"))
                .static_crt(true)
                .compile("dlvpx");
            println!(
                "cargo:rustc-link-search=native={}",
                prefix.join("lib").display()
            );
            println!("cargo:rustc-link-lib=static=vpx");
            println!("cargo:rustc-cfg=desklink_vpx");
        }
        return Ok(());
    }
    if let Some(prefix) = std::env::var_os("DESKLINK_VPX_STATIC_DIR").map(PathBuf::from) {
        if !prefix.join("include/vpx/vp8cx.h").exists() || !prefix.join("lib/libvpx.a").exists() {
            return Err(format!("DESKLINK_VPX_STATIC_DIR must be the libvpx install prefix containing include/vpx/vp8cx.h and lib/libvpx.a, not its lib directory: {}", prefix.display()).into());
        }
    }
    if target_os == "macos" && std::env::var_os("DESKLINK_MACOS_CLI").is_some() {
        println!("cargo:rustc-cfg=desklink_macos_cli");
    }
    if target_os == "linux" {
        let static_vpx = std::env::var_os("DESKLINK_VPX_STATIC_DIR").map(PathBuf::from);
        let mut shim = cc::Build::new();
        shim.file("native/vpx_shim.c")
            .flag_if_supported("-Wno-unused-parameter");
        if let Some(prefix) = &static_vpx {
            shim.include(prefix.join("include"));
        }
        shim.compile("dlvpx");
        match &static_vpx {
            Some(prefix) => {
                println!(
                    "cargo:rustc-link-search=native={}",
                    prefix.join("lib").display()
                );
                println!("cargo:rustc-link-lib=static=vpx");
            }
            None => println!("cargo:rustc-link-lib=vpx"),
        }
    }

    if target_os == "linux" {
        // H.264 through NVENC and VA-API: the driver libraries are dlopen'd at
        // run time, so building needs only their vendored MIT headers, and a
        // machine without them still runs the engine.
        cc::Build::new()
            .file("native/nvenc_shim.c")
            .include("vendor/nv-codec-headers/include")
            .compile("dlnvenc");
        cc::Build::new()
            .file("native/vaapi_shim.c")
            .include("vendor/libva")
            .compile("dlvaapi");
        println!("cargo:rustc-link-lib=dl");
        let mut overlay = cc::Build::new();
        let includes = std::process::Command::new("pkg-config")
            .args(["--cflags", "freetype2", "fontconfig"])
            .output()?;
        if !includes.status.success() {
            return Err("FreeType and Fontconfig development headers are required".into());
        }
        for flag in String::from_utf8(includes.stdout)?.split_whitespace() {
            overlay.flag(flag);
        }
        overlay
            .file("native/agent_overlay_x11.c")
            .file("native/agent_overlay_wayland.c")
            .compile("dlagentoverlay");
        for lib in [
            "X11",
            "Xext",
            "Xcursor",
            "wayland-client",
            "fontconfig",
            "freetype",
            "m",
        ] {
            println!("cargo:rustc-link-lib={lib}");
        }
        cc::Build::new()
            .cpp(true)
            .std("c++17")
            .include("vendor/inputtino/src/uinput/include")
            .file("native/inputtino_shim.cpp")
            .compile("dlinputkey");
        build_inputtino(&PathBuf::from(std::env::var("OUT_DIR")?))?;
    } else if target_os == "macos" {
        cc::Build::new()
            .cpp(true)
            .file("native/mac_stream.mm")
            .flag("-fobjc-arc")
            .compile("dlmacstream");
        cc::Build::new()
            .file("native/agent_overlay_mac.m")
            .flag("-fobjc-arc")
            .compile("dlagentoverlay");
        for framework in [
            "ScreenCaptureKit",
            "CoreVideo",
            "CoreMedia",
            "Foundation",
            "AppKit",
            "QuartzCore",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
        if let Some(prefix) = std::env::var_os("DESKLINK_VPX_STATIC_DIR").map(PathBuf::from) {
            cc::Build::new()
                .file("native/vpx_shim.c")
                .include(prefix.join("include"))
                .compile("dlvpx");
            println!(
                "cargo:rustc-link-search=native={}",
                prefix.join("lib").display()
            );
            println!("cargo:rustc-link-lib=static=vpx");
            println!("cargo:rustc-cfg=desklink_vpx");
            // H.264 for receivers that decode it in hardware; VideoToolbox is a
            // system framework, so linking it adds no dependency.
            cc::Build::new().file("native/vt_shim.c").compile("dlvt");
            println!("cargo:rustc-link-lib=framework=VideoToolbox");
            println!("cargo:rustc-link-lib=framework=CoreFoundation");
        }
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        println!("cargo:rustc-link-lib=framework=ApplicationServices");
        println!("cargo:rustc-link-lib=framework=Carbon");
        // The dev harness embeds its bundle identity for local TCC qualification.
        // The published CLI must inherit the responsible app's TCC identity instead.
        if std::env::var_os("DESKLINK_MACOS_CLI").is_none() {
            println!("cargo:rustc-link-arg-bins=-sectcreate");
            println!("cargo:rustc-link-arg-bins=__TEXT");
            println!("cargo:rustc-link-arg-bins=__info_plist");
            println!(
                "cargo:rustc-link-arg-bins={}",
                Path::new("Info.plist").canonicalize()?.display()
            );
        }
    }
    Ok(())
}

fn build_inputtino(out: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let source = Path::new("vendor/inputtino");
    if !source.join("CMakeLists.txt").exists() {
        return Err("the vendored inputtino source is missing from engine/vendor/inputtino".into());
    }
    let destination = out.join("inputtino-build");
    let configured = std::process::Command::new("cmake")
        .args([
            "-S",
            &source.display().to_string(),
            "-B",
            &destination.display().to_string(),
            "-DCMAKE_BUILD_TYPE=Release",
            "-DBUILD_SHARED_LIBS=OFF",
            "-DBUILD_C_BINDINGS=ON",
            "-DBUILD_TESTING=OFF",
            "-DUSE_UHID=OFF",
            "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
        ])
        .status()
        .is_ok_and(|s| s.success());
    if !configured {
        return Err(
            "cmake could not configure the vendored inputtino project; install cmake and libevdev"
                .into(),
        );
    }
    let compiled = std::process::Command::new("cmake")
        .args([
            "--build",
            &destination.display().to_string(),
            "--target",
            "libinputtino",
        ])
        .status()
        .is_ok_and(|s| s.success());
    if !compiled {
        return Err("cmake could not build the vendored inputtino project".into());
    }
    println!("cargo:rustc-link-search=native={}", destination.display());
    println!("cargo:rustc-link-lib=static=libinputtino");
    println!("cargo:rustc-link-lib=dylib=stdc++");
    // inputtino statically embeds its own code but not libevdev, which it calls
    // into for uinput device management.
    println!("cargo:rustc-link-lib=dylib=evdev");
    Ok(())
}
