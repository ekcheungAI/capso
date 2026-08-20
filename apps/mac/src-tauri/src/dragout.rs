use image::{DynamicImage, ImageFormat};
use std::{
    ffi::OsStr,
    fs::{self, OpenOptions},
    io::{self, Cursor, Write},
    path::{Component, Path, PathBuf},
};

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
pub(crate) const DRAG_PREVIEW_MAX_WIDTH: u32 = 180;
pub(crate) const DRAG_PREVIEW_MAX_HEIGHT: u32 = 112;

#[derive(Debug)]
pub(crate) struct PreparedDragArtifact {
    pub(crate) export_path: PathBuf,
    pub(crate) preview_png: Vec<u8>,
    pub(crate) bytes: u64,
    export_directory: PathBuf,
    retained: bool,
}

impl PreparedDragArtifact {
    pub(crate) fn retain(mut self) {
        self.retained = true;
    }
}

impl Drop for PreparedDragArtifact {
    fn drop(&mut self) {
        if !self.retained {
            cleanup_drag_artifact(self);
        }
    }
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .map(|id| id.to_string() == value)
        .unwrap_or(false)
}

fn validate_capture_source(capture_directory: &Path, source: &Path) -> Result<(), String> {
    if source.parent() != Some(capture_directory) {
        return Err("The active capture is outside Capso's protected capture directory.".into());
    }
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("Could not inspect the capture for dragging: {error}"))?;
    if !metadata.file_type().is_file() || metadata.len() == 0 {
        return Err("The active capture is no longer a regular PNG file.".into());
    }
    if source.extension() != Some(OsStr::new("png")) {
        return Err("The active capture is not a PNG file.".into());
    }
    let id = source
        .file_stem()
        .and_then(OsStr::to_str)
        .ok_or_else(|| "The active capture has an invalid filename.".to_string())?;
    if !canonical_uuid(id) {
        return Err("The active capture identifier is invalid.".into());
    }
    Ok(())
}

fn safe_drag_filename(value: &str) -> Result<&str, String> {
    let path = Path::new(value);
    let is_one_normal_component = matches!(
        path.components().collect::<Vec<_>>().as_slice(),
        [Component::Normal(_)]
    );
    if !is_one_normal_component
        || value.is_empty()
        || value.len() > 128
        || value.starts_with('.')
        || value.contains(['/', '\\', ':'])
        || path.extension() != Some(OsStr::new("png"))
    {
        return Err("Choose a plain PNG filename for the dragged capture.".into());
    }
    Ok(value)
}

fn bounded_preview(image: DynamicImage) -> Result<Vec<u8>, String> {
    let preview =
        if image.width() <= DRAG_PREVIEW_MAX_WIDTH && image.height() <= DRAG_PREVIEW_MAX_HEIGHT {
            image
        } else {
            image.thumbnail(DRAG_PREVIEW_MAX_WIDTH, DRAG_PREVIEW_MAX_HEIGHT)
        };
    let mut encoded = Cursor::new(Vec::new());
    preview
        .write_to(&mut encoded, ImageFormat::Png)
        .map_err(|error| format!("Could not prepare the drag preview: {error}"))?;
    Ok(encoded.into_inner())
}

pub(crate) fn prepare_drag_artifact(
    capture_directory: &Path,
    export_root: &Path,
    source: &Path,
    filename: &str,
) -> Result<PreparedDragArtifact, String> {
    validate_capture_source(capture_directory, source)?;
    let original = fs::read(source)
        .map_err(|error| format!("Could not read the capture for dragging: {error}"))?;
    prepare_drag_bytes(export_root, &original, filename)
}

pub(crate) fn prepare_drag_bytes(
    export_root: &Path,
    original: &[u8],
    filename: &str,
) -> Result<PreparedDragArtifact, String> {
    let filename = safe_drag_filename(filename)?;
    if !original.starts_with(PNG_SIGNATURE) {
        return Err("The dragged image is not a valid PNG.".into());
    }
    let decoded = image::load_from_memory_with_format(&original, ImageFormat::Png)
        .map_err(|error| format!("Could not decode the image for dragging: {error}"))?;
    let preview_png = bounded_preview(decoded)?;

    fs::create_dir_all(export_root)
        .map_err(|error| format!("Could not create Capso's drag cache: {error}"))?;
    let export_directory = export_root.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir(&export_directory)
        .map_err(|error| format!("Could not reserve a drag export: {error}"))?;
    let export_path = export_directory.join(filename);

    let write_result = (|| -> io::Result<()> {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&export_path)?;
        output.write_all(original)?;
        output.sync_all()
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&export_path);
        let _ = fs::remove_dir(&export_directory);
        return Err(format!(
            "Could not prepare the dragged capture copy: {error}"
        ));
    }

    Ok(PreparedDragArtifact {
        export_path,
        preview_png,
        bytes: original.len() as u64,
        export_directory,
        retained: false,
    })
}

pub(crate) fn cleanup_drag_artifact(artifact: &PreparedDragArtifact) {
    let _ = fs::remove_file(&artifact.export_path);
    let _ = fs::remove_dir(&artifact.export_directory);
}

fn owned_export_file(directory: &Path) -> io::Result<Option<PathBuf>> {
    let metadata = fs::symlink_metadata(directory)?;
    if !metadata.file_type().is_dir() {
        return Ok(None);
    }
    let Some(id) = directory.file_name().and_then(OsStr::to_str) else {
        return Ok(None);
    };
    if !canonical_uuid(id) {
        return Ok(None);
    }
    let entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    if entries.len() != 1 {
        return Ok(None);
    }
    let entry = &entries[0];
    let metadata = fs::symlink_metadata(entry.path())?;
    if !metadata.file_type().is_file() || entry.path().extension() != Some(OsStr::new("png")) {
        return Ok(None);
    }
    Ok(Some(entry.path()))
}

/// Removes only proxy files created by a completed prior Capso process. A live
/// drag session cannot survive relaunch, while unrelated or ambiguous cache
/// contents are deliberately left untouched.
pub(crate) fn cleanup_drag_exports(export_root: &Path) -> io::Result<usize> {
    let entries = match fs::read_dir(export_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    let mut removed = 0;
    for entry in entries.filter_map(Result::ok) {
        let directory = entry.path();
        let Some(file) = owned_export_file(&directory)? else {
            continue;
        };
        fs::remove_file(file)?;
        fs::remove_dir(directory)?;
        removed += 1;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::{
        cleanup_drag_artifact, cleanup_drag_exports, prepare_drag_artifact, prepare_drag_bytes,
        DRAG_PREVIEW_MAX_HEIGHT, DRAG_PREVIEW_MAX_WIDTH, PNG_SIGNATURE,
    };
    use image::{DynamicImage, GenericImageView, ImageFormat};
    use std::{fs, io::Cursor, path::Path};

    const CAPTURE_ID: &str = "018f22c4-cada-7c6b-9d5b-fc35f7f9227a";

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::new_rgba8(width, height)
            .write_to(&mut bytes, ImageFormat::Png)
            .expect("encode PNG fixture");
        bytes.into_inner()
    }

    fn write_capture(directory: &Path, bytes: &[u8]) -> std::path::PathBuf {
        fs::create_dir_all(directory).expect("create captures directory");
        let path = directory.join(format!("{CAPTURE_ID}.png"));
        fs::write(&path, bytes).expect("write capture fixture");
        path
    }

    #[test]
    fn drag_artifact_is_a_friendly_exact_copy_with_a_bounded_preview() {
        let root = tempfile::tempdir().expect("temporary app directory");
        let captures = root.path().join("captures");
        let exports = root.path().join("drag-exports");
        let original = png(640, 480);
        let source = write_capture(&captures, &original);

        let artifact = prepare_drag_artifact(
            &captures,
            &exports,
            &source,
            "Capso 2026-08-08 at 05.30.00.png",
        )
        .expect("prepare drag artifact");

        assert_ne!(artifact.export_path, source);
        assert_eq!(
            artifact
                .export_path
                .file_name()
                .and_then(|name| name.to_str()),
            Some("Capso 2026-08-08 at 05.30.00.png")
        );
        assert_eq!(artifact.bytes, original.len() as u64);
        assert_eq!(
            fs::read(&artifact.export_path).expect("read drag copy"),
            original
        );
        assert_eq!(fs::read(&source).expect("source remains exact"), original);
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_ne!(
                fs::metadata(&artifact.export_path)
                    .expect("drag copy metadata")
                    .ino(),
                fs::metadata(&source).expect("source metadata").ino(),
                "the drag copy must not share an inode with the protected original"
            );
        }

        let preview = image::load_from_memory_with_format(&artifact.preview_png, ImageFormat::Png)
            .expect("decode drag preview");
        assert!(preview.width() <= DRAG_PREVIEW_MAX_WIDTH);
        assert!(preview.height() <= DRAG_PREVIEW_MAX_HEIGHT);
        assert_eq!((preview.width(), preview.height()), (149, 112));

        let export_path = artifact.export_path.clone();
        cleanup_drag_artifact(&artifact);
        assert!(!export_path.exists());
        assert_eq!(
            fs::read(&source).expect("cleanup preserves source"),
            original
        );
    }

    #[test]
    fn flattened_annotation_drag_is_an_isolated_exact_png() {
        let root = tempfile::tempdir().expect("temporary app directory");
        let exports = root.path().join("drag-exports");
        let flattened = png(320, 180);

        let artifact = prepare_drag_bytes(&exports, &flattened, "Capso Annotation 2026-08-13.png")
            .expect("prepare flattened drag artifact");

        assert_eq!(
            fs::read(&artifact.export_path).expect("read flattened drag copy"),
            flattened
        );
        assert_eq!(artifact.bytes, flattened.len() as u64);
        assert_eq!(
            image::load_from_memory_with_format(&artifact.preview_png, ImageFormat::Png)
                .expect("decode flattened drag preview")
                .dimensions(),
            (DRAG_PREVIEW_MAX_WIDTH, 101)
        );
        let export_path = artifact.export_path.clone();
        cleanup_drag_artifact(&artifact);
        assert!(!export_path.exists());
    }

    #[test]
    fn flattened_annotation_drag_rejects_invalid_or_unsafe_pixels_before_export() {
        let root = tempfile::tempdir().expect("temporary app directory");
        let exports = root.path().join("drag-exports");

        assert!(prepare_drag_bytes(&exports, b"not a png", "Capso Annotation.png").is_err());
        assert!(prepare_drag_bytes(&exports, &png(8, 8), "../outside.png").is_err());
        assert!(!exports.exists());
    }

    #[test]
    fn unsafe_or_noncanonical_drag_sources_are_rejected_before_export() {
        let root = tempfile::tempdir().expect("temporary app directory");
        let captures = root.path().join("captures");
        let exports = root.path().join("drag-exports");
        let source = write_capture(&captures, &png(10, 10));

        assert!(prepare_drag_artifact(&captures, &exports, &source, "../outside.png").is_err());
        assert!(prepare_drag_artifact(&captures, &exports, &source, ".hidden.png").is_err());

        let outside = root.path().join(format!("{CAPTURE_ID}.png"));
        fs::write(&outside, png(10, 10)).expect("write outside file");
        assert!(prepare_drag_artifact(&captures, &exports, &outside, "Capso Capture.png").is_err());

        let noncanonical = captures.join("capture.png");
        fs::write(&noncanonical, png(10, 10)).expect("write noncanonical capture");
        assert!(
            prepare_drag_artifact(&captures, &exports, &noncanonical, "Capso Capture.png").is_err()
        );

        fs::write(&source, PNG_SIGNATURE).expect("truncate canonical capture");
        assert!(prepare_drag_artifact(&captures, &exports, &source, "Capso Capture.png").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_capture_is_never_exported() {
        let root = tempfile::tempdir().expect("temporary app directory");
        let captures = root.path().join("captures");
        let exports = root.path().join("drag-exports");
        fs::create_dir_all(&captures).expect("create captures directory");
        let outside = root.path().join("outside.png");
        fs::write(&outside, png(10, 10)).expect("write outside file");
        let symlink = captures.join(format!("{CAPTURE_ID}.png"));
        std::os::unix::fs::symlink(&outside, &symlink).expect("create capture symlink");

        assert!(prepare_drag_artifact(&captures, &exports, &symlink, "Capso Capture.png").is_err());
        assert!(!exports.exists());
    }

    #[test]
    fn startup_cleanup_removes_only_owned_single_png_export_directories() {
        let root = tempfile::tempdir().expect("temporary app directory");
        let exports = root.path().join("drag-exports");
        let owned = exports.join("018f22c4-cada-7c6b-9d5b-fc35f7f92270");
        let unexpected = exports.join("keep-me");
        let ambiguous = exports.join("018f22c4-cada-7c6b-9d5b-fc35f7f92271");
        fs::create_dir_all(&owned).expect("create owned export");
        fs::create_dir_all(&unexpected).expect("create unexpected directory");
        fs::create_dir_all(&ambiguous).expect("create ambiguous directory");
        fs::write(owned.join("Capso Capture.png"), b"proxy").expect("write owned export");
        fs::write(unexpected.join("notes.txt"), b"keep").expect("write unrelated data");
        fs::write(ambiguous.join("one.png"), b"one").expect("write first ambiguous file");
        fs::write(ambiguous.join("two.png"), b"two").expect("write second ambiguous file");

        assert_eq!(cleanup_drag_exports(&exports).expect("cleanup exports"), 1);
        assert!(!owned.exists());
        assert!(unexpected.join("notes.txt").exists());
        assert!(ambiguous.join("one.png").exists());
        assert!(ambiguous.join("two.png").exists());
    }
}
