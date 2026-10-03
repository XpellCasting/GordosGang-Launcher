# Homestead distribution

The launcher reads its production distribution from:

```text
https://josedh-1.tailb15ed6.ts.net:10000/distribution.json
```

The manifest connects Minecraft and the status query to:

```text
stamina-home.tun.ply.gg:25565
```

The Tailscale IP is only used for server administration. It is not embedded in
the launcher or distribution, so players do not need to join the tailnet.

## Published client

`scripts/sync-homestead-distribution.py` converts the official Homestead
Modrinth pack into a Helios distribution. It includes:

- Homestead 1.3.7 for Minecraft 1.20.1.
- Fabric Loader 0.18.4 and its runtime libraries.
- Every client artifact and override declared by the official `.mrpack`.
- Mods marked `both` or `client` in `~/aievents/modpack.lock.json`.
- Client resource packs from the same lock file.

Official Modrinth artifacts retain their CDN URLs. Only pack overrides, local
extras, Fabric metadata, news, and launcher artwork are served by Homestead.
Every artifact has an MD5 checksum consumed by the launcher's existing repair
flow.

## Updating the distribution

On the Homestead host, download the desired `.mrpack`, update the pinned pack
metadata and extras, copy the current synchronizer, `homestead-news.json` and
`app/assets/images/AppIcon.png` to `~/homestead/launcher-source/`, and run:

```console
python3 ~/homestead/launcher-source/sync-homestead-distribution.py \
  --mrpack /tmp/homestead-1.3.7.mrpack \
  --public-dir ~/homestead/launcher-public \
  --base-url https://josedh-1.tailb15ed6.ts.net:10000 \
  --server-address stamina-home.tun.ply.gg \
  --server-data ~/homestead/data \
  --extras-root ~/aievents \
  --icon ~/homestead/launcher-source/AppIcon.png
```

`--icon` is the server artwork shown in the launcher's server picker and on the
Mods and Performance settings tabs.

The generator builds into a temporary directory and replaces the published
directory only after every artifact has been processed successfully.

## News

The launcher's news panel reads `news.xml`, which the synchronizer writes from
`scripts/homestead-news.json` (or the file passed with `--news`). Without either
file it publishes a single default item.

```json
{
  "title": "GordosGang Launcher",
  "description": "Noticias del servidor Homestead",
  "items": [
    {
      "id": "evento-halloween-2026",
      "title": "Evento de Halloween",
      "date": "2026-10-31T20:00:00-03:00",
      "author": "GordosGang",
      "summary": "Una línea para lectores RSS.",
      "html": "<p>Cuerpo del artículo en HTML.</p>",
      "link": "https://discord.gg/zNWUXdt"
    }
  ]
}
```

`id`, `title`, `date` and `html` are required; `date` must carry a UTC offset.
Items are published newest first, and the newest one lights the dot on the
launcher's news button until the player opens the panel. `link` is optional;
when present the panel offers to open it in the browser.

The article HTML is sanitized by the launcher: scripts, iframes, forms, inline
styles and event handlers are dropped, and only `http(s)` links and images are
kept. Headings, paragraphs, lists, images, links and `code` are styled.

To publish news without rebuilding the client:

```console
python3 ~/homestead/launcher-source/sync-homestead-distribution.py --news-only \
  --public-dir ~/homestead/launcher-public \
  --base-url https://josedh-1.tailb15ed6.ts.net:10000
```

Players see the change the next time the launcher starts.

## Local overrides

Anything under `~/aievents/staging/overrides/` is published with the same
semantics as a pack override: the path is instance-relative and the launcher
restores the file whenever its MD5 differs. A local override at a path the pack
also ships *replaces* the pack's file rather than adding a second module for the
same destination. Each run prints every local override and whether it replaced
something.

Use it for settings that belong to a mod added here, which the pack's own
overrides cannot know about.

Nothing is shipped this way right now.

Two caveats before reaching for it. The launcher restores any file it manages
whenever the MD5 differs, so a config a mod rewrites at runtime gets reset on
every launch and player edits last one session. And the distribution is shared
by every OS, so it cannot carry a fix that only one platform needs — see
`DARWIN_CONFIG_OVERRIDES` in `app/assets/js/processbuilder.js` for that case.

If you want a default that players can still change, write it to
`staging/overrides/config/yosbr/<path>` instead: yosbr copies a file only when
the target is absent, so fresh installs get the default and existing installs
keep their own.

## Excluded pack files

`PACK_EXCLUSIONS` at the top of the synchronizer drops a file the `.mrpack`
declares, matched on filename prefix. An exclusion is **two-sided**: the file is
left out of the client distribution, and the sync refuses to run at all while
that file is still present in `<server-data>/mods`, so a mod can never be
removed from one side while it keeps running on the other. Every run prints
what it excluded and whether any rule matched a server mod.

Currently excluded:

| Pack file | Why |
| --- | --- |
| `sodiumoptionsmodcompat-*` | Builds Sodium's Video Settings page for Entity Model Features against an older EMF enum set — it supplies 6 names for `RenderModeChoice` (EMF 3.3.9 declares 5, `GREEN` was removed), 4 for `ModelPrintMode` (declares 5) and 2 for `VanillaModelRenderMode` (declares 3). Sodium's `CyclingControl` validates those lengths, so opening Video Settings throws `IllegalArgumentException` and kills the client. The integration only activates because EMF is added as a local extra; the stock pack ships no EMF. Nothing in the pack depends on this mod, so the only loss is editing ETF/EMF settings from inside Sodium's screen — their own config screens stay reachable through Mod Menu. |

Before adding a rule, check that nothing declares a dependency on the mod:

```console
cd <modstore>/mods/fabric
for j in $(find . -name '*.jar'); do
  unzip -p "$j" fabric.mod.json 2>/dev/null \
    | grep -l "<mod-id>" >/dev/null && echo "$j"
done
```

## Pinned extras

`EXTRA_PINS` at the top of the synchronizer overrides the version a lock entry
names. A pin matches on filename prefix, downloads the replacement from the
declared URL, and refuses to publish unless the size and sha1 match, so a pin
can never silently resolve to something else. Each run prints the substitution
it made.

Currently pinned:

| Lock entry | Published instead | Why |
| --- | --- | --- |
| `DistantHorizons-3.*` | `DistantHorizons-2.4.5-b-1.20.1-fabric-forge.jar` | DH 3.x calls `ThreadPoolUtil.shutdownThreadPools()` without null-checking `networkClientHandlerThreadPool`, so every client disconnect — kick, timeout, or the Disconnect button — throws a `NullPointerException` and kills the game instead of showing the disconnect screen. Confirmed in 3.2.0-b, 3.3.2 and 3.3.3; 2.4.5-b predates that thread pool. |

Removing a pin is deliberate: drop the entry once an upstream release is
verified to no longer carry the defect.

Note that DH 2.x and 3.x use incompatible LOD databases. After this pin first
reaches a client that had already run 3.x, its `Distant_Horizons_server_data/`
has to be deleted so the LODs regenerate.

The public endpoint is provided by Tailscale Funnel:

```console
sudo tailscale funnel --bg --yes --https=10000 ~/homestead/launcher-public
```

To remove public access without touching Minecraft or the generated files:

```console
sudo tailscale funnel --https=10000 off
```

After an update, verify `health.json`, parse `distribution.json` with Helios,
and test at least one Fabric loader, override, local extra, and Modrinth CDN
artifact against its declared size and MD5.
