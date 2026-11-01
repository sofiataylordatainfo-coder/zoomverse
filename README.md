# ZOMBIE RUN

Real-time GPS zombie tag for up to 7 players per room. Blood-red horror theme, live map, secret zombie, 10-minute round.

## Put it online (so phones can use GPS)

The game needs a small Node server (it keeps the rooms and players in sync in real time), so it must go on a host that runs Node, not a plain static host like GitHub Pages or Netlify. Any of these give you a free **https://** link, which is what makes the "Allow location" prompt work on phones:

**Render (easiest)**
1. Put this folder in a GitHub repository.
2. On render.com choose **New > Blueprint**, pick the repo, and click Apply. (`render.yaml` sets everything up.)
3. In a minute or two you get a link like `https://zombie-run.onrender.com`. Send it to your friends.

**Railway / Fly.io / Google Cloud Run**
Deploy the repository directly. A `Procfile` and a `Dockerfile` are included, and the server reads the `PORT` the host provides.

Notes: free tiers can go to sleep when nobody has played for a while, so the first load may take up to a minute. Rooms live in memory, so a restart ends any game in progress. Keep it to one server instance.

## Run it on your own computer

```bash
npm install
npm start          # http://localhost:3000
```

Optional settings (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Server port |
| `CATCH_RADIUS` | 6 | Metres at which a zombie infects a human |
| `GAME_SECONDS` | 600 | Total round length (10 min) |
| `HIDE_SECONDS` | 30 | Head start before the zombie can infect |
| `MIN_PLAYERS` | 2 | Players needed to start |

## On phones

- When someone taps Create or Join, the browser asks for location permission. If they refuse, the game explains how to turn it back on (iPhone and Android steps).
- The screen is kept awake during a game so GPS keeps reporting. Phones stop sharing location when the screen locks or the browser is in the background, so ask players to keep the game open.
- "Add to Home Screen" installs it as a full-screen app with an icon.
- Works in portrait and landscape, and respects notches and the home bar.

## Testing alone

Tick **Test mode** on the home screen. GPS is ignored and you tap the map to move yourself. Open the site in several browser tabs, join the same room, and walk the "zombie" tab onto another player to see the infection.

## How a round works

1. Host creates a room and shares the 5-character code or invite link. Up to 7 players join.
2. Host starts. One player is picked as the zombie in secret. Everyone gets the **RUN AND HIDE FROM THE ZOMBIE** popup and can privately peek at their own role.
3. **Hide phase** (30 s): everyone scatters. The zombie is hidden from other players' screens.
4. **Hunt phase**: all zombies appear on every map in red. Humans get a heartbeat warning and vibration when a zombie is close.
5. When a zombie's GPS position comes within the catch radius of a human, the human is turned. Every screen is notified instantly, and new zombies can infect too.
6. Zombies win if everyone is infected. Humans win if anyone is still human when the timer ends.

## Sound

Everything is generated in the browser: effects and music use WebAudio, and voice lines use the browser's built-in speech synthesis (pitched down and slowed). There are no audio files. Browsers only allow sound after a first tap, which happens naturally when joining. Tap the speaker button (top right) for **Effects / Music / Voice** volume sliders and a mute-all switch; settings are remembered.

- **Music:** a slow, dark looping bed during the hide phase that speeds up and adds a pulsing beat when the hunt starts
- **Ambient drone** under the music
- **Voice lines:** "Run. And hide. The zombie is among you.", "The hunt has begun. Run.", "The zombie is close." (when one is within 15 m), "You have been infected.", "<name> has been turned.", "One minute left.", "You are the last survivor.", plus win and lose lines
- **Effects:** alarm siren and growl at hunt start; humans hear a heartbeat that speeds up as a zombie closes in; zombies hear a sonar ping that speeds up near prey; growl and boom on infection; countdown ticks in the last 10 seconds; win and lose stingers

Voice quality depends on the phone's built-in voices, so it will sound a little different on iPhone and Android. Set Voice to 0 to turn spoken lines off.

## About "2-3 feet" accuracy

Phone GPS is typically accurate to 3-10 metres (10-30 ft), even outdoors, and worse near buildings. A 2-3 ft catch radius would almost never trigger, or would trigger randomly. The default is 6 m; tune it with `CATCH_RADIUS` after trying it on your playing field. For true foot-level accuracy you would need extra hardware (UWB or Bluetooth beacons).

## Files

- `server.js`: WebSocket game server (rooms, roles, catch detection, timer)
- `public/index.html`: the whole front end (map via Leaflet, blood theme, animations)
