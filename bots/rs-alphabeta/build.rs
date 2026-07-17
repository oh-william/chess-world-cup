// Link the libchess C ABI shared library built by CMake in <repo>/build, and
// bake an rpath so the binary finds it at runtime without DYLD_LIBRARY_PATH.
use std::env;
use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let build_dir = manifest.parent().unwrap().parent().unwrap().join("build");
    let dir = build_dir.display();
    println!("cargo:rustc-link-search=native={dir}");
    println!("cargo:rustc-link-lib=dylib=libchess_c");
    println!("cargo:rustc-link-arg=-Wl,-rpath,{dir}");
    println!("cargo:rerun-if-changed=build.rs");
}
