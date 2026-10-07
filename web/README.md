# Cipheroom web

The Angular app: standalone components, signals, ng-zorro UI themed in Less, plain WebRTC for media (one peer
connection to Cloudflare Realtime SFU, see `core/media/`) and SignalR for all signaling. Built into a static nginx
image (`web/Dockerfile`) for the compose stack.

```bash
npm ci                       # install (or let scripts/dev.sh do it)
scripts/dev.sh               # from the repo root: API + this app on :4200 (proxied, see proxy.conf.json)
scripts/test.sh --web        # unit tests
scripts/icons.sh             # regenerate public/ icons from design/*.svg
```

```
src/app/
  core/        app-wide services and providers (signaling, media, settings, ui)
  shared/      reusable directives and pure template helpers
  features/    routed screens (home, room); one folder per component: .ts .html .less .spec.ts
src/theme/     ng-zorro light/dark themes (Less)
design/        logo masters for scripts/icons.sh (not part of the build)
```

Conventions: [`.claude/skills/angular-frontend/SKILL.md`](../.claude/skills/angular-frontend/SKILL.md).
