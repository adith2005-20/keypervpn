# Repository Guidelines

## Project Structure & Module Organization
Source lives under `src/`. Keep transport and networking logic in `src/p2p/`, VPN device and encryption code in `src/vpn/`, signaling in `src/signaling/`, and the Ink terminal UI in `src/ui/`. Shared interfaces belong in `src/types.ts`; the CLI entry point is `src/index.ts`. Build output is emitted to `dist/` by TypeScript and should not be edited by hand.

## Build, Test, and Development Commands
- `npm install`: install project dependencies.
- `npm run build`: compile TypeScript from `src/` to `dist/`.
- `npm start`: start the main app through `tsx src/index.ts`.
- `npm run signal`: start the WebSocket signaling server on the default port.
- `sudo npm start server`: run the VPN in server mode with TUN access.
- `sudo npm start client`: run the VPN in client mode with TUN access.

Use `SIGNAL_URL=ws://host:8080 sudo npm start client` to point a client at a non-default signaling server.

## Coding Style & Naming Conventions
This repository uses strict TypeScript (`strict: true`) with ESM (`module: NodeNext`). Follow the existing style: 4-space indentation, semicolons, single quotes, and PascalCase for classes/components (`VPNTunnel`, `CryptoEngine`, `App`). Keep files focused on one responsibility and name them by exported class or role. Prefer explicit types on public APIs and keep shared contracts in `src/types.ts`.

## Testing Guidelines
There is no automated test framework configured yet. At minimum, run `npm run build` before submitting changes. For behavior changes, perform a manual smoke test:
- start `npm run signal`
- launch `sudo npm start server`
- launch `sudo npm start client`
- verify tunnel setup and connectivity, for example `ping 10.8.0.1`

When adding tests later, place them alongside the relevant module or under a dedicated `tests/` directory and name them `*.test.ts`.

## Commit & Pull Request Guidelines
Use short conventional commit subjects; the current history uses `feat: ...`. Prefer prefixes like `feat:`, `fix:`, and `docs:` with an imperative summary. Pull requests should explain the networking or crypto impact, list verification steps, and include terminal output or screenshots when the Ink UI changes.

## Security & Configuration Tips
Do not commit secrets, private keys, or real peer addresses. Document any change to default ports, subnets, STUN settings, or TUN device behavior in `README.md` and the PR description.
