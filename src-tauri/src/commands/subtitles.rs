use crate::persistence::save_persisted_state;
use crate::state::*;

#[tauri::command]
pub(crate) fn get_subtitle_shortcut(
    state: tauri::State<'_, RuntimeState>,
) -> Result<SubtitleShortcutSettings, String> {
    state
        .subtitle_shortcut
        .lock()
        .map_err(|_| "Subtitle shortcut lock failed".to_string())
        .map(|v| v.clone())
}

#[tauri::command]
pub(crate) fn set_subtitle_shortcut(
    app: tauri::AppHandle,
    settings: SubtitleShortcutSettings,
    state: tauri::State<'_, RuntimeState>,
) -> Result<(), String> {
    if !settings.key_code.trim().is_empty() {
        let dictation = state
            .dictation
            .lock()
            .map_err(|_| "Dictation lock failed".to_string())?;
        if dictation.key_code == settings.key_code
            && dictation_mods(&dictation) == subtitle_shortcut_mods(&settings)
        {
            return Err("该快捷键已被语音输入占用".to_string());
        }
    }
    apply_subtitle_hotkey(&settings)?;
    {
        let mut guard = state
            .subtitle_shortcut
            .lock()
            .map_err(|_| "Subtitle shortcut lock failed".to_string())?;
        *guard = settings;
    }
    save_persisted_state(&app, &state)?;
    Ok(())
}
