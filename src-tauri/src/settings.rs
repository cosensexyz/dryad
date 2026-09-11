use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub concurrency: usize,
    pub timeout_secs: u64,
    pub stale_days: u32,
    pub patch_max_lines: usize,
    pub files_max: usize,
    pub sidebar_width: u32,
    pub files_width: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { concurrency: 8, timeout_secs: 60, stale_days: 30, patch_max_lines: 5000, files_max: 500, sidebar_width: 260, files_width: 280 }
    }
}

impl Settings {
    pub fn load(file: &Path) -> Settings {
        std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn save(&self, file: &Path) -> std::io::Result<()> {
        if let Some(d) = file.parent() { std::fs::create_dir_all(d)?; }
        std::fs::write(file, serde_json::to_string_pretty(self).expect("settings serialize"))
    }

    /// Layout is clamped client-side against the live container; these bounds are only a sanity net.
    pub fn set_pane_widths(&mut self, sidebar: u32, files: u32) {
        self.sidebar_width = sidebar.clamp(120, 1200);
        self.files_width = files.clamp(120, 1200);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_design() {
        let s = Settings::default();
        assert_eq!((s.concurrency, s.timeout_secs, s.stale_days, s.patch_max_lines, s.files_max), (8, 60, 30, 5000, 500));
        assert_eq!((s.sidebar_width, s.files_width), (260, 280));
    }

    #[test]
    fn pane_widths_clamp_and_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("settings.json");
        let mut s = Settings::default();
        s.set_pane_widths(400, 10);
        assert_eq!((s.sidebar_width, s.files_width), (400, 120));
        s.set_pane_widths(5000, 5000);
        assert_eq!((s.sidebar_width, s.files_width), (1200, 1200));
        s.save(&f).unwrap();
        assert_eq!((Settings::load(&f).sidebar_width, Settings::load(&f).files_width), (1200, 1200));
    }

    #[test]
    fn partial_and_corrupt_files_fall_back_field_by_field() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("settings.json");
        assert_eq!(Settings::load(&f), Settings::default());
        std::fs::write(&f, r#"{"staleDays": 7}"#).unwrap();
        let s = Settings::load(&f);
        assert_eq!(s.stale_days, 7);
        assert_eq!(s.concurrency, 8);
        std::fs::write(&f, "garbage").unwrap();
        assert_eq!(Settings::load(&f), Settings::default());
        let mut s = Settings::default();
        s.stale_days = 90;
        s.save(&f).unwrap();
        assert_eq!(Settings::load(&f).stale_days, 90);
    }
}
