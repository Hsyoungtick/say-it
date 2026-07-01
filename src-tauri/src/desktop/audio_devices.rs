use crate::prelude::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioDeviceInfo {
    pub(crate) name: String,
    pub(crate) is_default: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioDeviceList {
    pub(crate) inputs: Vec<AudioDeviceInfo>,
    pub(crate) outputs: Vec<AudioDeviceInfo>,
}

#[tauri::command]
pub(crate) fn list_audio_devices() -> Result<AudioDeviceList, String> {
    let host = cpal::default_host();

    let default_input_name = host
        .default_input_device()
        .and_then(|device| device.name().ok());
    let default_output_name = host
        .default_output_device()
        .and_then(|device| device.name().ok());

    let inputs = host
        .input_devices()
        .map_err(|e| format!("枚举麦克风设备失败: {e}"))?
        .filter_map(|device| device.name().ok())
        .map(|name| AudioDeviceInfo {
            is_default: Some(&name) == default_input_name.as_ref(),
            name,
        })
        .collect();

    let outputs = host
        .output_devices()
        .map_err(|e| format!("枚举播放设备失败: {e}"))?
        .filter_map(|device| device.name().ok())
        .map(|name| AudioDeviceInfo {
            is_default: Some(&name) == default_output_name.as_ref(),
            name,
        })
        .collect();

    Ok(AudioDeviceList { inputs, outputs })
}
