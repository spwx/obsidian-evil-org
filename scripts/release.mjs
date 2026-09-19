// Cut a release: bump manifest.json, record the build in versions.json, run
// the tests, then commit and tag. manifest.json stays the source of truth for
// the version; package.json is private and deliberately has none.
//
//   npm run release -- 1.1.3          edit the two files, test, commit, tag
//   npm run release -- 1.1.3 --push   ...and push main and the tag
//
// The commit message opens in $EDITOR prefilled with "Bump to <version>", so
// the body can describe what changed. Pass --no-edit to keep just that line.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

const git = (...args) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const run = (cmd, ...args) =>
  execFileSync(cmd, args, { cwd: repo, stdio: "inherit" });

const die = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const push = args.includes("--push");
const edit = !args.includes("--no-edit");
const [version] = args.filter((a) => !a.startsWith("--"));

if (!version) die("usage: npm run release -- <version> [--push] [--no-edit]");
if (!/^\d+\.\d+\.\d+$/.test(version)) die(`"${version}" is not a x.y.z version`);

// A dirty tree or a stale main would tag something other than what was tested.
if (git("status", "--porcelain")) die("working tree is not clean");
if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") die("not on main");
git("fetch", "origin", "main", "--tags");
// Being ahead of origin/main is the normal state just before a release; being
// behind or diverged would tag a tree that is missing what is already pushed.
try {
  git("merge-base", "--is-ancestor", "origin/main", "HEAD");
} catch {
  die("main is behind or has diverged from origin/main; pull first");
}
if (git("tag", "--list", version)) die(`tag ${version} already exists`);

const manifestPath = join(repo, "manifest.json");
const versionsPath = join(repo, "versions.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const versions = JSON.parse(readFileSync(versionsPath, "utf8"));

const rank = (v) =>
  v.split(".").reduce((acc, part) => acc * 1000 + Number(part), 0);

if (rank(version) <= rank(manifest.version))
  die(`${version} is not newer than manifest.json's ${manifest.version}`);

manifest.version = version;
// versions.json tells older Obsidian installs which build still runs for them,
// so every released version needs an entry — the release workflow checks it.
versions[version] = manifest.minAppVersion;

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(versionsPath, `${JSON.stringify(versions, null, 2)}\n`);

// Same two commands the Release workflow runs, so a red build fails here first.
run("npm", "run", "build");
run("npm", "test");

git("add", "manifest.json", "versions.json");
run("git", "commit", ...(edit ? ["-e"] : []), "-m", `Bump to ${version}`);
git("tag", version);

if (push) {
  run("git", "push", "origin", "main", version);
  console.log(`\nPushed ${version}. The Release workflow builds it now.`);
} else {
  console.log(`\nCommitted and tagged ${version}. To publish:`);
  console.log(`  git push origin main ${version}`);
}
