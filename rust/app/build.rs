//! Embeds the app icon and version details in the Windows executable. GPUI
//! loads the window and taskbar icon from icon resource 1.

fn main() {
    println!("cargo:rerun-if-changed=assets/violetwire.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let mut resource = winresource::WindowsResource::new();
    resource
        .set_icon_with_id("assets/violetwire.ico", "1")
        .set("ProductName", "VioletWire")
        .set("FileDescription", "VioletWire")
        .set("CompanyName", "VioletWire")
        .set("LegalCopyright", "VioletWire contributors");
    if let Err(error) = resource.compile() {
        // A missing resource compiler leaves the default icon, not a failed build.
        println!("cargo:warning=Could not embed the app icon: {error}");
    }
}
