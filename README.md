# 2P Tetris

A shared-board, two-player Tetris game. Two tetrominoes fall at the same time. Airborne pieces may overlap; settled pieces never do.

## Run locally

Serve the repository with any static web server, then open the printed URL in a browser:

```bash
python3 -m http.server 8080 --directory dist
```

For an online room, both browsers need internet access so PeerJS can exchange WebRTC connection metadata. Once connected, game messages travel over a direct peer-to-peer data channel. **Local duo** works without the room service.

## Controls

In an online match, either arrow keys or WASD work on each player's own computer. `Space`/`Enter` hard-drops and `C`/`Shift` holds.

Local duo uses:

- Player 1: `A` / `D` move, `W` rotate, `S` soft-drop, `Space` hard-drop, `C` hold.
- Player 2: arrow keys move/rotate/drop, `Enter` hard-drop, right `Shift` hold.

## Test

```bash
npm test
npm run check
```

## Publish on GitHub Pages

Push the repository to GitHub, open **Settings → Pages**, and choose **GitHub Actions** as the source. The included workflow publishes `dist/` on every push to `main`.

The four-digit room code is a compact PeerJS peer ID. For a production event with many concurrent rooms, replace the public PeerJS signaling service with your own PeerServer; gameplay remains peer-to-peer.
