# Better MC 4 distribution

The launcher refreshes its production manifest at startup and again whenever a
player presses **Play**:

```text
https://josedh-1.tailb15ed6.ts.net:10000/distribution.json
```

`scripts/sync-bmc4-distribution.py` converts the official CurseForge client
export into a Helios distribution. The generated manifest uses a new instance
id (`Better-MC-1.20.1`), so Fabric files from Homestead can never be mixed with
the Forge installation.

The generator publishes:

- Better MC 4 Forge 1.20.1 v61.
- Forge 47.4.20 and its generated client libraries.
- Every CurseForge artifact declared by the official client pack, retaining
  the original CurseForge CDN URLs and MD5 hashes, except artifacts explicitly
  replaced by the server's client pack.
- All mod JARs are installed in the instance's standard `mods/` directory.
  This is required for early-loading services such as Sinytra Connector;
  loading Connector through Forge's Maven mod list leaves `connectormod`
  unavailable when Fabric compatibility dependencies are sorted.
- The mandatory Arclight server additions from
  `~/bmc4/cliente/BMC4-josedh-mods-extra.zip`. Client-only files under
  `mods-opcionales/` are intentionally not installed.
- The official pack overrides in one verified archive, except root
  `options.txt` and `servers.dat`; those belong to the player and are not reset
  on every launch. The launcher extracts the archive only when its hash changes
  and otherwise restores just missing managed files.
- GordosGang artwork and the Spanish news feed.

## Rollout order

Release launcher **1.1.0 before replacing the public distribution**. The new
launcher migrates a saved Homestead server selection to the manifest's main
server. Older launcher builds do not have that fallback and would leave the
Play button disabled when the server id changes.

## Build and publish

On the distribution host, download the official client export (not the server
pack) and run the synchronizer with Java 17 or newer:

```console
curl -L \
  -o /tmp/bmc4-forge-1.20.1-v61.zip \
  'https://mediafilez.forgecdn.net/files/8689/205/BMC4%20%5BFORGE%5D%201.20.1%20v61.zip'

python3 ~/homestead/launcher-source/sync-bmc4-distribution.py \
  --client-pack /tmp/bmc4-forge-1.20.1-v61.zip \
  --extra-pack ~/bmc4/cliente/BMC4-josedh-mods-extra.zip \
  --exclude-curse-file collective-1.20.1-8.39.jar \
  --exclude-curse-file stop_rendering-forge-1.0.3.jar \
  --public-dir ~/homestead/launcher-public \
  --base-url https://josedh-1.tailb15ed6.ts.net:10000 \
  --server-address stamina-home.tun.ply.gg \
  --icon ~/homestead/launcher-source/AppIcon.png \
  --news ~/homestead/launcher-source/bmc4-news.json \
  --java java
```

`stop_rendering` is excluded because its `@Redirect` on
`LivingEntityRenderer` collides with the Legends mod from the extra pack, which
then fails its required injection and crashes the client at startup.

The script resolves the exact project/file pairs from the CurseForge manifest,
validates their metadata, prepares the Forge client, writes into a temporary
directory, and only then replaces `launcher-public`. A failed build leaves the
currently published distribution untouched.

By default metadata is read through the keyless Curse.Tools compatibility API.
To use the official CurseForge API instead, export `CURSEFORGE_API_KEY` and pass
`--curse-api-base https://api.curseforge.com/v1`.

The public endpoint remains served by Tailscale Funnel:

```console
sudo tailscale funnel --bg --yes --https=10000 ~/homestead/launcher-public
```

## Verification

After publication, check that `health.json` names `v61`, Forge `47.4.20`, and
server id `Better-MC-1.20.1` in `distribution.json`. Then launch once on a clean
machine and once with an existing Homestead configuration. Both should select
Better MC automatically; the second machine should retain the old Homestead
instance in its own directory.

