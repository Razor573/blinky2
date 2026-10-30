use blinky_agent::agent::r#loop::parse_pointing_tags;
use blinky_agent::decision::{DecisionRoute, System1Classifier};
use blinky_agent::providers::{
    ChatMessage, ChatMessagePart, ModelTier,
    DEFAULT_PROVIDER_ROTATION,
};
use blinky_agent::tools::desktop::{
    is_black_frame, normalize_to_screen_coordinates, point_to_absolute_mouse, DaemonRpcClient,
};

#[test]
fn test_provider_dispatch_and_rotation_config() {
    assert_eq!(
        DEFAULT_PROVIDER_ROTATION,
        &["gemini", "vertex", "antigravity", "codex"]
    );

    let default_tier = ModelTier::default();
    assert_eq!(default_tier, ModelTier::Fast);

    let msg = ChatMessage::user_multimodal(vec![
        ChatMessagePart::text("Look at this screen"),
        ChatMessagePart::image_url("https://example.com/screenshot.png"),
    ]);

    assert_eq!(msg.text_content(), "Look at this screen");
    assert_eq!(msg.parts.len(), 2);
}

#[tokio::test]
async fn test_linux_daemon_not_required_on_windows() {
    let client = DaemonRpcClient::new();
    let res = client.call("blinky.focusWindow", serde_json::json!({})).await;
    assert!(res.is_ok(), "DaemonRpcClient should not bail on Windows");
}

#[test]
fn test_coordinate_mapping_and_black_frame() {
    // 1. Pure black frame (sampled 2048 pixels, channel max <= 16, fraction >= 0.995)
    let black_pixels = vec![5u8; 1920 * 1080 * 4];
    assert!(is_black_frame(&black_pixels, 1920, 1080, 4));

    // 2. Normal bright frame
    let bright_pixels = vec![200u8; 1920 * 1080 * 4];
    assert!(!is_black_frame(&bright_pixels, 1920, 1080, 4));

    // 3. Fail-open on empty or truncated pixels
    assert!(!is_black_frame(&[], 0, 0, 4));
    assert!(!is_black_frame(&[0u8; 10], 1920, 1080, 4));

    // 4. Normalized [u, v] to screen coordinates
    let (x, y) = normalize_to_screen_coordinates(0.5, 0.5, 1920, 1080);
    assert_eq!((x, y), (960, 540));

    // 5. Pixel to SendInput absolute mouse coordinates (0..65535)
    let (abs_x, abs_y) = point_to_absolute_mouse(960, 540, 0, 0, 1920, 1080);
    assert!((abs_x - 32767).abs() <= 35);
    assert!((abs_y - 32767).abs() <= 35);
}

#[test]
fn test_system1_router_fast_path_vs_general_bypass() {
    // Fast-path atomic commands
    let mute_adv = System1Classifier::classify("mute");
    assert!(mute_adv.is_atomic_fast_path);
    assert_eq!(mute_adv.route, DecisionRoute::DaemonSystem);

    let vol_adv = System1Classifier::classify("volume up");
    assert!(vol_adv.is_atomic_fast_path);
    assert_eq!(vol_adv.route, DecisionRoute::DaemonSystem);

    let lock_adv = System1Classifier::classify("lock workstation");
    assert!(lock_adv.is_atomic_fast_path);
    assert_eq!(lock_adv.route, DecisionRoute::DaemonSystem);

    // General queries must NEVER be hijacked by System 1 atomic fast-path
    let q1 = System1Classifier::classify("what is the capital of France?");
    assert!(!q1.is_atomic_fast_path);

    let q2 = System1Classifier::classify("write a python function to compute fibonacci numbers");
    assert!(!q2.is_atomic_fast_path);

    let q3 = System1Classifier::classify("explain how quantum computing works");
    assert!(!q3.is_atomic_fast_path);
}

#[test]
fn test_pointing_tags_parser_and_bounds() {
    let text = "Here is the button: [POINT:150,250:Submit Button] and here is another [POINT:5000,5000:Invalid]";
    let tags = parse_pointing_tags(text, 1920, 1080);

    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0].x, 150);
    assert_eq!(tags[0].y, 250);
    assert_eq!(tags[0].label, "Submit Button");
}
