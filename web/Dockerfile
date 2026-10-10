# Build context: repo root (needs deploy/nginx).
FROM node:lts-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# AGPL §13: /source redirects to the code this image was built from (scripts/up.sh passes the commit when the
# working tree is clean; otherwise the repository itself). Filled in here: the nginx image runs as non-root.
ARG SOURCE_URL=https://github.com/Alex-Fix/cipheroom
ARG SOURCE_COMMIT=
COPY deploy/nginx/default.conf /tmp/default.conf
RUN echo "$SOURCE_URL" | grep -Eq '^https://[A-Za-z0-9._~/-]+$' \
      || { echo "SOURCE_URL must be a plain https:// URL" >&2; exit 1; } \
    && { [ -z "$SOURCE_COMMIT" ] || echo "$SOURCE_COMMIT" | grep -Eq '^[0-9a-f]{7,40}$'; } \
      || { echo "SOURCE_COMMIT must be a git commit hash" >&2; exit 1; } \
    && target="${SOURCE_URL%/}${SOURCE_COMMIT:+/tree/$SOURCE_COMMIT}" \
    && sed "s|@SOURCE_TARGET@|$target|" /tmp/default.conf > /tmp/default.conf.out \
    && grep -q "return 302 $target;" /tmp/default.conf.out

FROM nginxinc/nginx-unprivileged:1.31-alpine
COPY --from=build /tmp/default.conf.out /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/web/browser /usr/share/nginx/html
EXPOSE 8080
