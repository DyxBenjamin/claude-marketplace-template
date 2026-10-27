/**
 * @file Syncs marketplace.json with each plugin's plugin.json and generates the release-please config and manifest.
 * @tags ci, marketplace, release-please
 * @related .claude-plugin/marketplace.json, release-please-config.json, .github/workflows/release.yml
 */

/**
 * Syncs marketplace.json and generates release-please configuration.
 *
 * Source of truth: plugins/<name>/.claude-plugin/plugin.json
 *
 * A plugin's version lives only in its plugin.json (bumped by Release Please).
 * Marketplace entries carry no version: Claude Code reads plugin.json, and
 * `claude plugin validate` warns when both declare one.
 *
 * This script:
 *   1. Scans plugins/ directory for plugin folders
 *   2. Syncs marketplace.json with discovered plugins
 *   3. Generates release-please-config.json and manifest
 *
 * When adding a new plugin, just create:
 *   plugins/<name>/.claude-plugin/plugin.json
 *
 * The rest is automated.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGINS_DIR = path.join(ROOT, 'plugins');
const MARKETPLACE_PATH = path.join(ROOT, '.claude-plugin', 'marketplace.json');
const CONFIG_PATH = path.join(ROOT, 'release-please-config.json');
const MANIFEST_PATH = path.join(ROOT, '.release-please-manifest.json');

const PluginJson = z.looseObject({
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
});

const MarketplaceEntry = z.looseObject({
  name: z.string(),
  source: z.unknown(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
});

const Marketplace = z.looseObject({ plugins: z.array(MarketplaceEntry) });

const Manifest = z.record(z.string(), z.string());

const ReleaseConfig = z.object({
  $schema: z.string(),
  'release-type': z.string(),
  'bump-minor-pre-major': z.boolean(),
  'bump-patch-for-minor-pre-major': z.boolean(),
  'include-component-in-tag': z.boolean(),
  'include-v-in-tag': z.boolean(),
  'pull-request-title-pattern': z.string(),
  'separate-pull-requests': z.boolean(),
  'changelog-sections': z.array(
    z.object({ type: z.string(), section: z.string(), hidden: z.boolean().optional() }),
  ),
  packages: z.record(
    z.string(),
    z.object({
      component: z.string(),
      'changelog-path': z.string(),
      'extra-files': z.array(z.object({ type: z.string(), path: z.string(), jsonpath: z.string() })),
    }),
  ),
});

type PluginJson = z.infer<typeof PluginJson>;
type Marketplace = z.infer<typeof Marketplace>;

function readJson<T extends z.ZodType>(file: string, schema: T): z.infer<T> {
  return schema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function discoverPlugins(): { dirName: string; json: PluginJson }[] {
  const plugins: { dirName: string; json: PluginJson }[] = [];

  if (!fs.existsSync(PLUGINS_DIR)) {
    return plugins;
  }

  const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pluginJsonPath = path.join(PLUGINS_DIR, entry.name, '.claude-plugin', 'plugin.json');

    if (!fs.existsSync(pluginJsonPath)) {
      console.warn(`Warning: ${entry.name}/ has no .claude-plugin/plugin.json, skipping`);
      continue;
    }

    plugins.push({
      dirName: entry.name,
      json: readJson(pluginJsonPath, PluginJson),
    });
  }

  return plugins;
}

function syncMarketplace(plugins: { dirName: string; json: PluginJson }[]): Marketplace {
  // Validated, then kept as read: parsing reorders keys and the file keeps its own order.
  const raw: unknown = JSON.parse(fs.readFileSync(MARKETPLACE_PATH, 'utf8'));
  Marketplace.parse(raw);
  const marketplace = raw as Marketplace;
  const existingByName = new Map(marketplace.plugins.map((p, i) => [p.name, i]));
  let updated = false;

  for (const plugin of plugins) {
    const pj = plugin.json;
    const idx = existingByName.get(pj.name);

    if (idx !== undefined) {
      // Update existing plugin - sync all fields
      const existing = marketplace.plugins[idx];

      const changes: string[] = [];

      // Sync all fields from plugin.json
      if (existing.source !== `./plugins/${plugin.dirName}`) {
        existing.source = `./plugins/${plugin.dirName}`;
        changes.push('source');
      }
      if (existing.description !== pj.description) {
        existing.description = pj.description || '';
        changes.push('description');
      }
      if ('version' in existing) {
        delete existing.version;
        changes.push('version (removed)');
      }
      if (JSON.stringify(existing.keywords) !== JSON.stringify(pj.keywords || [])) {
        existing.keywords = pj.keywords || [];
        changes.push('keywords');
      }

      if (changes.length > 0) {
        updated = true;
        console.log(`Updated ${pj.name}: ${changes.join(', ')}`);
      }
    } else {
      // Add new plugin
      marketplace.plugins.push({
        name: pj.name,
        source: `./plugins/${plugin.dirName}`,
        description: pj.description || '',
        keywords: pj.keywords || [],
      });
      updated = true;
      console.log(`Added new plugin: ${pj.name}`);
    }
  }

  if (updated) {
    Marketplace.parse(marketplace);
    writeJson(MARKETPLACE_PATH, marketplace);
    console.log('Updated .claude-plugin/marketplace.json');
  }

  return marketplace;
}

function generateReleaseConfig(marketplace: Marketplace): void {
  // Read existing manifest to preserve versions
  const existingManifest = fs.existsSync(MANIFEST_PATH) ? readJson(MANIFEST_PATH, Manifest) : {};

  const packages: z.infer<typeof ReleaseConfig>['packages'] = {};
  const manifest: Record<string, string> = {};

  marketplace.plugins.forEach((plugin) => {
    const pluginPath = `plugins/${plugin.name}`;
    const pluginJsonPath = path.join(ROOT, pluginPath, '.claude-plugin', 'plugin.json');

    if (!fs.existsSync(pluginJsonPath)) {
      console.warn(`Warning: Plugin ${plugin.name} directory not found, skipping`);
      return;
    }

    const pluginJson = readJson(pluginJsonPath, PluginJson);
    const version = existingManifest[pluginPath] || pluginJson.version || '0.1.0';

    // Each plugin versions independently. Release Please bumps only its own
    // plugin.json, the single place a plugin's version is declared.
    packages[pluginPath] = {
      component: plugin.name,
      'changelog-path': 'CHANGELOG.md',
      'extra-files': [
        {
          type: 'json',
          path: '.claude-plugin/plugin.json',
          jsonpath: '$.version',
        },
      ],
    };

    manifest[pluginPath] = version;
  });

  const config = ReleaseConfig.parse({
    $schema: 'https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json',
    'release-type': 'simple',
    'bump-minor-pre-major': false,
    'bump-patch-for-minor-pre-major': false,
    'include-component-in-tag': true,
    'include-v-in-tag': true,
    'pull-request-title-pattern': 'chore(release): ${component} ${version}',
    'separate-pull-requests': true,
    'changelog-sections': [
      { type: 'feat', section: 'Features' },
      { type: 'fix', section: 'Bug Fixes' },
      { type: 'perf', section: 'Performance' },
      { type: 'docs', section: 'Documentation' },
      { type: 'chore', section: 'Maintenance', hidden: true },
    ],
    packages,
  });

  writeJson(CONFIG_PATH, config);
  writeJson(MANIFEST_PATH, Manifest.parse(manifest));

  console.log(`Generated release-please-config.json with ${Object.keys(packages).length} package(s)`);
  console.log(`Updated .release-please-manifest.json`);
}

function main(): void {
  const plugins = discoverPlugins();
  console.log(`Discovered ${plugins.length} plugin(s) in plugins/`);

  const marketplace = syncMarketplace(plugins);
  generateReleaseConfig(marketplace);
}

main();
