# Runs the autonomous debate service (src/debate/cli.ts) via tsx, the same way
# it runs locally (`npm run debate`) -- no separate build step, so the same
# source that was tested is exactly what runs in the container.
#
# Plain `node:20`, not `-slim`: `better-sqlite3` (used by the sibling mentions
# pipeline, installed regardless) ships prebuilt binaries for common platforms,
# but the full image has a fallback toolchain if a prebuild isn't available for
# a given arch, which is worth the extra size for a service meant to just work
# on whatever VPS it's deployed to.
FROM node:20

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY config ./config
COPY prompts ./prompts
# Frozen technocore-sonnet-challenge package (rules, cmudict.dict, the
# official validator script) -- sonnet/cmudict.ts and validator.ts read this
# at runtime, unlike config/prompts it's never edited on the host, so it's
# baked into the image rather than volume-mounted.
COPY vendor ./vendor

ENV NODE_ENV=production

# config/ and prompts/ are also volume-mounted in docker-compose.yml so that
# editing them on the host and `docker compose restart` applies the change
# without a rebuild -- the COPY above only matters for `docker run` without
# compose, or the very first `docker compose up` before the bind mount exists.
CMD ["npx", "tsx", "src/debate/cli.ts"]
