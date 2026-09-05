use serde::Serialize;
use std::env;
use std::fs::{metadata, read_dir};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, PartialEq, Eq)]
struct FileEntry {
    path: String,
    bytes: u64,
}

#[derive(Debug, Serialize)]
struct Inventory {
    files: Vec<FileEntry>,
    file_count: usize,
    markdown_count: usize,
    total_bytes: u64,
}

fn ignored(name: &str) -> bool {
    matches!(name, ".git" | ".cortex" | "node_modules")
}

fn visit(root: &Path, directory: &Path, files: &mut Vec<FileEntry>) -> std::io::Result<()> {
    for entry in read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if ignored(&name) {
            continue;
        }
        let path = entry.path();
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            visit(root, &path, files)?;
        } else if file_type.is_file() {
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let bytes = metadata(&path)?.len();
            files.push(FileEntry {
                path: relative,
                bytes,
            });
        }
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = env::args()
        .nth(1)
        .ok_or("usage: projection-probe <vault-root>")?;
    let root = PathBuf::from(root).canonicalize()?;
    let mut files = Vec::new();
    visit(&root, &root, &mut files)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let markdown_count = files
        .iter()
        .filter(|entry| entry.path.to_ascii_lowercase().ends_with(".md"))
        .count();
    let total_bytes = files.iter().map(|entry| entry.bytes).sum();
    let inventory = Inventory {
        file_count: files.len(),
        markdown_count,
        total_bytes,
        files,
    };
    println!("{}", serde_json::to_string(&inventory)?);
    Ok(())
}
