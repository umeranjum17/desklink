//! Windows clipboard seam. This build never reads or writes the clipboard.
pub const MAX_CLIPBOARD_BYTES: usize = 256 * 1024;
pub fn read_or_explain() -> Result<(String, bool), String> {
    Err("Windows clipboard transfer is not implemented in this build.".into())
}
pub fn write(_text: &str) -> anyhow::Result<()> {
    anyhow::bail!("Windows clipboard transfer is not implemented in this build.")
}
