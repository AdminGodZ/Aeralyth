# Audit Docker inventory draft

Captured 2026-09-12T12:17:07.874269+00:00.

Read-only inventory. Nothing was stopped or removed. Final checks are still active; any future cleanup must recheck exact IDs and attachments.

## Audit containers

| Name | ID | State | Published ports | Ownership |
|---|---|---|---|---|
| `aeralyth-audit-db-suite-20260912` | `153d72b51279ea65595076978a1e52b053773df5ad9abd3f5d0726ec457f17b0` | running | 127.0.0.1:55434 -> 5432/tcp | Compose project aeralyth-audit-db-suite and task-specific /tmp/aeralyth-audit-db-suite.compose.yml |
| `aeralyth-audit-s3-20260912` | `62a74a0cbd912ad99e47336868556c866b59ed8aa6a53748d88cc996611370f8` | running | 127.0.0.1:59000 -> 9000/tcp | Container label aeralyth.task=performance-audit-20260912 |
| `aeralyth-audit-20260912` | `832beb83fb65bf8422d43ebe8681960419e7f9899b7d2da8b62cda7c8281c30b` | running | 127.0.0.1:55432 -> 5432/tcp | Container label aeralyth.task=performance-audit-20260912 |

## Container mounts

- `aeralyth-audit-db-suite-20260912`
  - bind: `/Users/timheld/Documents/Projects/Aeralyth/database/init` at `/aeralyth-migrations`; source `/Users/timheld/Documents/Projects/Aeralyth/database/init`; writable=False.
  - volume: `4463f12963892db7ee061df18d0f0273a475a8d9cd6cbf07b77a6f9a51ed0898` at `/var/lib/postgresql`; source `/var/lib/docker/volumes/4463f12963892db7ee061df18d0f0273a475a8d9cd6cbf07b77a6f9a51ed0898/_data`; writable=True.

- `aeralyth-audit-s3-20260912`
  - volume: `b128e34ef8eb435f79db6ee917120f4e3b63349b7f36a017da243792bf9b705d` at `/data`; source `/var/lib/docker/volumes/b128e34ef8eb435f79db6ee917120f4e3b63349b7f36a017da243792bf9b705d/_data`; writable=True.

- `aeralyth-audit-20260912`
  - volume: `e6e80fad3f207d95821b161c774ec3fcb5bef1c0f3882d4c5fbdc22514f3eb7f` at `/var/lib/postgresql`; source `/var/lib/docker/volumes/e6e80fad3f207d95821b161c774ec3fcb5bef1c0f3882d4c5fbdc22514f3eb7f/_data`; writable=True.

## Audit networks

- `aeralyth-audit-db-suite_default`. ID `af5edf12e3e7d86f82ca69b9921077ce0b2cc2c266c83725407fec30328b0eab`. Members: aeralyth-audit-db-suite-20260912. Non-audit members: 0. Labels: `{"com.docker.compose.config-hash": "626212c151292dcc171650330981e1676dd2cd6837a4af27c02bd8d70747986f", "com.docker.compose.network": "default", "com.docker.compose.project": "aeralyth-audit-db-suite", "com.docker.compose.version": "5.5.1"}`.
- `aeralyth-audit-integration-20260912`. ID `f4b8d55c99eb6c4e6ac30a4311f4c1e9466e840f7c94bbc89671947aa8e955a7`. Members: aeralyth-audit-s3-20260912, aeralyth-audit-20260912. Non-audit members: 0. Labels: `{}`.

## Audit volumes

- `4463f12963892db7ee061df18d0f0273a475a8d9cd6cbf07b77a6f9a51ed0898`. Created 2026-09-12T11:05:07Z. Attached only to aeralyth-audit-db-suite-20260912:/var/lib/postgresql. Mountpoint `/var/lib/docker/volumes/4463f12963892db7ee061df18d0f0273a475a8d9cd6cbf07b77a6f9a51ed0898/_data`. Labels: `{"com.docker.volume.anonymous": ""}`.
- `b128e34ef8eb435f79db6ee917120f4e3b63349b7f36a017da243792bf9b705d`. Created 2026-09-12T10:46:20Z. Attached only to aeralyth-audit-s3-20260912:/data. Mountpoint `/var/lib/docker/volumes/b128e34ef8eb435f79db6ee917120f4e3b63349b7f36a017da243792bf9b705d/_data`. Labels: `{"com.docker.volume.anonymous": ""}`.
- `e6e80fad3f207d95821b161c774ec3fcb5bef1c0f3882d4c5fbdc22514f3eb7f`. Created 2026-09-12T10:43:16Z. Attached only to aeralyth-audit-20260912:/var/lib/postgresql. Mountpoint `/var/lib/docker/volumes/e6e80fad3f207d95821b161c774ec3fcb5bef1c0f3882d4c5fbdc22514f3eb7f/_data`. Labels: `{"com.docker.volume.anonymous": ""}`.

## Task-built image, identity only

- Tags `aeralyth-audit-20260912:current`. ID `sha256:0d1348f5ae29632604e17af13d7be8035727246ccdf4c3b4343d989b46f7ccc6`. Created 2026-09-12T11:08:09.975586886Z. Containers referencing this exact image: 0. The active build may replace the tag.

The image is recorded for identity. Its removal is outside the requested container/network/volume inventory and needs separate authorization. No image or cache pruning is proposed.

## Preserve

- `aeralyth-postgres` on port 5432, its named data volume and `aeralyth_default` network are the existing development setup.
- Built-in `bridge`, `host` and `none` networks; unrelated AdminSearch and school/GitLab resources.
- Shared vendor/base images, including PostgreSQL, MinIO, Rust and Node. This inventory does not establish exclusive ownership of their layers or pull history.
- The repository bind mount `database/init`, build caches, node_modules, source files and saved audit evidence.

The JSON companion includes exact IDs, Compose labels, creation times, full mounts, port mappings and network membership. No environment variables or secret values were read into this inventory.
