import pytest
from unittest.mock import patch, AsyncMock, MagicMock
from computer_use.agent import try_run_agent_action
from computer_use.tools import ToolResult, play_spotify_track_tool

def test_agent_routes_play_spotify_in_spotify():
    with patch("computer_use.tools.play_spotify_track_tool") as mock_play:
        mock_play.return_value = MagicMock()
        result = try_run_agent_action("play blinding lights in spotify")
        
    assert result is mock_play.return_value
    mock_play.assert_called_once_with("blinding lights")

def test_agent_routes_play_spotify_on_spotify():
    with patch("computer_use.tools.play_spotify_track_tool") as mock_play:
        mock_play.return_value = MagicMock()
        result = try_run_agent_action("play blinding lights on spotify")
        
    assert result is mock_play.return_value
    mock_play.assert_called_once_with("blinding lights")

def test_agent_routes_play_spotify_prefix():
    with patch("computer_use.tools.play_spotify_track_tool") as mock_play:
        mock_play.return_value = MagicMock()
        result = try_run_agent_action("play spotify blinding lights")
        
    assert result is mock_play.return_value
    mock_play.assert_called_once_with("blinding lights")

@pytest.mark.asyncio
@patch("computer_use.tools.os.name", "posix")
@patch("computer_use.tools.platform.system", return_value="Linux")
@patch("computer_use.tools.open_spotify_uri_linux")
@patch("computer_use.tools.resolve_spotify_track_uri", new_callable=AsyncMock)
async def test_play_spotify_linux_uses_desktop_uri_handler(mock_resolve, mock_open_linux, mock_platform):
    mock_resolve.return_value = "spotify:track:6qYkmqFsXbj8CQjAdbYz07"
    mock_open_linux.return_value = ToolResult(
        True,
        "open_spotify_uri",
        "Opened Spotify URI.",
        {"method": "xdg-open", "track_uri": "spotify:track:6qYkmqFsXbj8CQjAdbYz07"},
    )

    result = play_spotify_track_tool("blinding lights")
        
    assert result.success is True
    assert result.details["track_uri"] == "spotify:track:6qYkmqFsXbj8CQjAdbYz07"
    assert result.details["method"] == "xdg-open"
    mock_open_linux.assert_called_once_with("spotify:track:6qYkmqFsXbj8CQjAdbYz07")

@pytest.mark.asyncio
@patch("computer_use.tools.os.name", "nt")
@patch("computer_use.tools.open_spotify_uri")
@patch("computer_use.tools.resolve_spotify_track_uri", new_callable=AsyncMock)
async def test_play_spotify_via_grounding_success(mock_resolve, mock_open_spotify):
    mock_resolve.return_value = "spotify:track:6qYkmqFsXbj8CQjAdbYz07"
    mock_open_spotify.return_value = ToolResult(
        True,
        "open_spotify_uri",
        "Opened Spotify URI.",
        {"method": "os.startfile", "track_uri": "spotify:track:6qYkmqFsXbj8CQjAdbYz07"},
    )
    result = play_spotify_track_tool("blinding lights")
    
    assert result.success is True
    assert result.details["track_uri"] == "spotify:track:6qYkmqFsXbj8CQjAdbYz07"
    mock_open_spotify.assert_called_once_with("spotify:track:6qYkmqFsXbj8CQjAdbYz07", song_name="blinding lights")

@pytest.mark.asyncio
@patch("computer_use.tools.os.name", "nt")
@patch("computer_use.tools.open_spotify_uri")
@patch("computer_use.tools.resolve_spotify_track_uri", new_callable=AsyncMock)
async def test_play_spotify_via_search_uri_fallback(mock_resolve, mock_open_spotify):
    mock_resolve.return_value = None
    mock_open_spotify.return_value = ToolResult(
        True,
        "open_spotify_uri",
        "Opened Spotify URI.",
        {"method": "os.startfile"},
    )
    result = play_spotify_track_tool("blinding lights")
    
    assert result.success is True
    assert "spotify:search:blinding%20lights" in result.details["track_uri"]

@pytest.mark.asyncio
@patch("computer_use.tools.os.name", "nt")
@patch("computer_use.tools.open_spotify_uri")
@patch("computer_use.tools.resolve_spotify_track_uri", new_callable=AsyncMock)
async def test_play_spotify_not_found(mock_resolve, mock_open_spotify):
    mock_resolve.return_value = None
    mock_open_spotify.return_value = ToolResult(
        False,
        "open_spotify_uri",
        "Launch failed",
        {},
    )
    result = play_spotify_track_tool("some unknown track 12345")
    
    assert result.success is False
    assert "Could not find track" in result.message

def test_clean_song_query():
    from computer_use.tools import clean_song_query
    assert clean_song_query("any latest subh song") == "subh"
    assert clean_song_query("play cheques") == "cheques"
    assert clean_song_query("the blinding lights") == "blinding lights"
    assert clean_song_query("latest new song by shubh") == "shubh"

def test_agent_routes_complex_query():
    with patch("computer_use.tools.play_spotify_track_tool") as mock_play:
        mock_play.return_value = MagicMock()
        result = try_run_agent_action("play any latest subh song in spotify")
        
    assert result is mock_play.return_value
    mock_play.assert_called_once_with("any latest subh song")

def test_agent_routes_voice_command():
    with patch("computer_use.tools.play_spotify_track_tool") as mock_play:
        mock_play.return_value = MagicMock()
        
        # Test punctuation stripping
        result = try_run_agent_action("play blinding lights in spotify.")
        assert result is mock_play.return_value
        
        result_q = try_run_agent_action("play blinding lights on spotify?")
        assert result_q is mock_play.return_value
        
        result_ex = try_run_agent_action("play blinding lights in spotify!  ")
        assert result_ex is mock_play.return_value

def test_agent_routes_stop_spotify():
    with patch("computer_use.agent.shortcut_tool") as mock_shortcut:
        mock_shortcut.return_value = MagicMock()
        
        result_stop = try_run_agent_action("stop spotify")
        assert result_stop is mock_shortcut.return_value
        mock_shortcut.assert_called_with("media_play_pause")
        
        result_pause = try_run_agent_action("pause music")
        assert result_pause is mock_shortcut.return_value
        
        result_resume = try_run_agent_action("resume playback")
        assert result_resume is mock_shortcut.return_value

def test_agent_routes_seek_controls():
    with patch("computer_use.tools.seek_spotify_tool") as mock_seek:
        mock_seek.return_value = MagicMock()
        
        # Test seek forward with seconds
        result = try_run_agent_action("skip 15 seconds forward")
        assert result is mock_seek.return_value
        mock_seek.assert_called_with(15, forward=True)
        
        # Test seek forward with minutes conversion (1 minute -> 60s)
        result_min = try_run_agent_action("skip 1 minute in song")
        assert result_min is mock_seek.return_value
        mock_seek.assert_called_with(60, forward=True)
        
        # Test seek backward with minutes conversion (2 mins -> 120s)
        result_mins_back = try_run_agent_action("go back 2 mins in song")
        assert result_mins_back is mock_seek.return_value
        mock_seek.assert_called_with(120, forward=False)
        
        # Test seek forward default seconds (10s)
        result_default = try_run_agent_action("fast forward")
        assert result_default is mock_seek.return_value
        mock_seek.assert_called_with(10, forward=True)
        
        # Test seek backward default seconds (10s)
        result_rewind = try_run_agent_action("rewind")
        assert result_rewind is mock_seek.return_value
        mock_seek.assert_called_with(10, forward=False)


def test_agent_routes_track_skips():
    with patch("computer_use.agent.shortcut_tool") as mock_shortcut:
        mock_shortcut.return_value = MagicMock()
        
        result_next = try_run_agent_action("next song")
        assert result_next is mock_shortcut.return_value
        mock_shortcut.assert_called_with("media_next")
        
        result_prev = try_run_agent_action("prev track")
        assert result_prev is mock_shortcut.return_value
        mock_shortcut.assert_called_with("media_prev")


def test_handle_media_playback_action():
    from computer_use.agent import handle_media_playback_action
    
    with patch("computer_use.tools.seek_spotify_tool") as mock_seek, \
         patch("computer_use.agent.shortcut_tool") as mock_shortcut, \
         patch("computer_use.tools.play_spotify_track_tool") as mock_play:
         
        mock_seek.return_value = MagicMock()
        mock_shortcut.return_value = MagicMock()
        mock_play.return_value = MagicMock()
        
        # Test seek forward
        handle_media_playback_action({"media_action": "seek", "seek_seconds": 60}, "skip 1 minute")
        mock_seek.assert_called_with(60, forward=True)
        
        # Test seek backward
        handle_media_playback_action({"media_action": "seek", "seek_seconds": -15}, "go back 15s")
        mock_seek.assert_called_with(15, forward=False)
        
        # Test pause
        handle_media_playback_action({"media_action": "pause"}, "pause music")
        mock_shortcut.assert_called_with("media_play_pause")
        
        # Test play song
        handle_media_playback_action({"media_action": "play", "song_name": "blinding lights"}, "play blinding lights")
        mock_play.assert_called_with("blinding lights")

