This repository is a single-page Hono and React application.
Install with npm ci --ignore-scripts --no-audit --no-fund.
Run npm run check for server tests, TypeScript checks, and production build.
The production server uses HOST and PORT and starts with npm start.
Keep / as the only frontend page. Unknown paths must return a JSON 404.
Use the existing UI components and API contracts. Add focused tests for changed behavior.
The controller owns Git commits, publication, review, and merge. Do not deploy.
Changes to protected verification inputs require trusted approval before automatic merge.
