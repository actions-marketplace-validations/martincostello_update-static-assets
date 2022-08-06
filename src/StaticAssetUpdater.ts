// Copyright (c) Martin Costello, 2022. All rights reserved.
// Licensed under the Apache 2.0 license. See the LICENSE file in the project root for full license information.

import * as fs from 'fs';
import * as glob from 'glob';

import { JSDOM, HTMLScriptElement, HTMLStyleElement } from 'jsdom';
import { Writable } from 'stream';

import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';

import { AssetUpdate } from './AssetUpdate';
import { CdnProvider } from './CdnProvider';
import { CdnFile } from './CdnFile';
import { UpdateOptions } from './UpdateOptions';
import { UpdateResult } from './UpdateResult';
import { CdnClient } from './clients/CdnClient';
import { CdnjsClient } from './clients/CdnjsClient';
import { JSDelivrClient } from './clients/JSDelivrClient';

export class StaticAssetUpdater {
  private static readonly cdnMap: Record<string, CdnProvider> = {
    'https://cdnjs.cloudflare.com': CdnProvider.cdnjs,
    'https://cdn.jsdelivr.net': CdnProvider.jsdelivr,
  };
  private readonly options: UpdateOptions;

  constructor(options: UpdateOptions) {
    this.options = options;
  }

  public static generateCommitMessage(
    assetName: string,
    currentAssetVersion: string,
    latestAssetVersion: string
  ): string {
    const currentVersion = currentAssetVersion.split('.');
    const latestVersion = latestAssetVersion.split('.');

    const updateKind =
      parseInt(latestVersion[0], 10) > parseInt(currentVersion[0], 10)
        ? 'major'
        : parseInt(latestVersion[1], 10) > parseInt(currentVersion[1], 10)
        ? 'minor'
        : 'patch';

    const messageLines = [
      `Update ${assetName}`,
      '',
      `Updates ${assetName} to version ${latestAssetVersion}.`,
      '',
      '---',
      'updated-dependencies:',
      `- dependency-name: ${assetName}`,
      '  dependency-type: direct:production',
      `  update-type: version-update:semver-${updateKind}`,
      '...',
      '',
      '',
    ];
    return messageLines.join('\n');
  }

  public async tryUpdateAssets(): Promise<UpdateResult> {
    const fileAssetMap: Record<string, AssetVersionItem[]> = {};
    const paths = this.findFiles();

    for (const fileName of paths) {
      const assets = this.findAssets(fileName);
      if (assets.length > 0) {
        fileAssetMap[fileName] = assets;
      }
    }

    // Find the unique assets present in the files.
    const assets: Asset[] = [];

    for (const fileName in fileAssetMap) {
      const fileAssets = fileAssetMap[fileName];
      for (const asset of fileAssets) {
        if (!assets.some((a) => a.cdn === asset.cdn && a.name === asset.name)) {
          assets.push({
            cdn: asset.cdn,
            name: asset.name,
          });
        }
      }
    }

    // Find the versions of each asset.
    const assetVersions: Record<string, AssetVersion[]> = {};

    for (const fileName in fileAssetMap) {
      const fileAssets = fileAssetMap[fileName];
      for (const asset of fileAssets) {
        const key = StaticAssetUpdater.getKey(asset);
        let versions = assetVersions[key];
        if (!versions) {
          versions = [];
        }
        if (!versions.some((a) => a.version === asset.version)) {
          versions.push({
            cdn: asset.cdn,
            name: asset.name,
            version: asset.version,
          });
        }
        assetVersions[key] = versions;
      }
    }

    // Find the latest version of each asset.
    const assetLatestVersions: Record<string, string> = {};
    for (const asset of assets) {
      const client = StaticAssetUpdater.getClient(asset.cdn);
      if (client) {
        const version = await client.getLatestVersion(asset.name);
        if (version) {
          const key = StaticAssetUpdater.getKey(asset);
          assetLatestVersions[key] = version;
        }
      }
    }

    // Are there any assets using a version that isn't the latest one?
    const assetsToUpdate: Asset[] = [];
    for (const asset of assets) {
      const key = StaticAssetUpdater.getKey(asset);
      const latestVersion = assetLatestVersions[key];
      const versions = assetVersions[key];
      if (versions) {
        for (const version of versions) {
          if (version.version !== latestVersion) {
            if (
              !assetsToUpdate.some(
                (a) => a.cdn === asset.cdn && a.name === asset.name
              )
            ) {
              assetsToUpdate.push({
                cdn: asset.cdn,
                name: asset.name,
              });
            }
          }
        }
      }
    }

    const result: UpdateResult = {
      updates: [],
    };

    // If we found any assets that need updating, loop through each unique asset and update any
    // versions that are not the latest version and create a pull request for asset that is.
    if (assetsToUpdate.length > 0) {
      core.info(`Found ${assetsToUpdate.length} assets to update.`);
      let baseBranch = '';
      for (const asset of assetsToUpdate) {
        const client = StaticAssetUpdater.getClient(asset.cdn);
        if (client) {
          const key = StaticAssetUpdater.getKey(asset);
          const version = assetLatestVersions[key];
          const latestFiles = await client.getFiles(asset.name, version);
          if (latestFiles.length > 0) {
            const updatedAsset = {
              cdn: asset.cdn,
              name: asset.name,
              version,
            };

            if (baseBranch) {
              // Reset to base branch before next loop
              await this.execGit(['checkout', baseBranch], true);
            } else {
              baseBranch = await this.getCurrentBranch();
            }

            const headBranch = await this.applyAssetUpdate(
              baseBranch,
              fileAssetMap,
              updatedAsset,
              latestFiles
            );

            if (headBranch) {
              const pullRequest = await this.createPullRequest(
                baseBranch,
                headBranch,
                updatedAsset
              );

              const update: AssetUpdate = {
                cdn: asset.cdn,
                name: asset.name,
                pullRequestNumber: pullRequest.number,
                pullRequestUrl: pullRequest.url,
                version,
              };

              result.updates.push(update);
            }
          }
        }
      }
    }

    return result;
  }

  private static getClient(provider: CdnProvider): CdnClient | null {
    switch (provider) {
      case CdnProvider.cdnjs:
        return new CdnjsClient();
      case CdnProvider.jsdelivr:
        return new JSDelivrClient();
      default:
        return null;
    }
  }

  private static getKey(asset: Asset): string {
    return `${asset.cdn}-${asset.name}`;
  }

  private findFiles(): string[] {
    const patterns: string[] = [];

    for (const extension of this.options.fileExtensions) {
      patterns.push(`**/*.${extension}`);
    }

    const options = {
      cwd: this.options.repoPath,
      nodir: true,
      realpath: true,
      silent: true,
    };

    const fileNames: string[] = [];

    for (const pattern of patterns) {
      const paths = glob.sync(pattern, options);
      for (const fileName of paths) {
        fileNames.push(fileName);
      }
    }

    return fileNames;
  }

  private findAssets(fileName: string): AssetVersionItem[] {
    const assets: AssetVersionItem[] = [];

    try {
      const html = fs.readFileSync(fileName, { encoding: 'utf8' });
      const dom = new JSDOM(html);
      const scripts = this.findScripts(dom);
      const styles = this.findStyles(dom);

      for (const script of scripts) {
        const asset = this.tryGetScriptAsset(script);
        if (asset) {
          assets.push(asset);
        }
      }

      for (const style of styles) {
        const asset = this.tryGetStyleAsset(style);
        if (asset) {
          assets.push(asset);
        }
      }
    } catch (error) {
      core.debug(`Failed to find assets in '${fileName}': ${error}`);
    }

    return assets;
  }

  private findScripts(dom: JSDOM): HTMLScriptElement[] {
    const elements: HTMLScriptElement[] = [];
    for (const element of dom.window.document.querySelectorAll('script')) {
      const script = element as HTMLScriptElement;
      if (script) {
        elements.push(script);
      }
    }
    return elements;
  }

  private findStyles(dom: JSDOM): HTMLStyleElement[] {
    const elements: HTMLStyleElement[] = [];
    for (const element of dom.window.document.querySelectorAll(
      'link[rel="stylesheet"]'
    )) {
      const link = element as HTMLStyleElement;
      if (link) {
        elements.push(link);
      }
    }
    return elements;
  }

  private tryGetScriptAsset(
    script: HTMLScriptElement
  ): AssetVersionItem | null {
    if (!script.src) {
      return null;
    }

    let integrity: string | null = null;
    const attribute = script.attributes['integrity'];

    if (attribute) {
      if (attribute.value) {
        integrity = attribute.value;
      }
    }

    return this.tryGetAsset(script.src, integrity);
  }

  private tryGetStyleAsset(style: HTMLStyleElement): AssetVersionItem | null {
    if (!style.href) {
      return null;
    }

    let integrity: string | null = null;
    const attribute = style.attributes['integrity'];

    if (attribute) {
      if (attribute.value) {
        integrity = attribute.value;
      }
    }

    return this.tryGetAsset(style.href, integrity);
  }

  private tryGetAsset(
    url: string,
    integrity: string | null
  ): AssetVersionItem | null {
    let provider: CdnProvider | null = null;

    for (const prefix in StaticAssetUpdater.cdnMap) {
      if (url.startsWith(prefix)) {
        provider = StaticAssetUpdater.cdnMap[prefix];
        break;
      }
    }

    if (!provider) {
      return null;
    }

    return this.extractAsset(provider, url, integrity);
  }

  private extractAsset(
    provider: CdnProvider,
    url: string,
    integrity: string | null
  ): AssetVersionItem | null {
    const uri = new URL(url);
    const uriPath = uri.pathname.slice(1);
    let segments = uriPath.split('/');
    let fileName = '';

    switch (provider) {
      case CdnProvider.cdnjs:
        if (segments.length >= 4) {
          fileName = segments.slice(4).join('/');
          return {
            cdn: provider,
            name: segments[2],
            version: segments[3],
            url,
            integrity,
            fileName,
          };
        }
        return null;

      case CdnProvider.jsdelivr:
        if (segments.length >= 2) {
          fileName = `/${segments.slice(2).join('/')}`;
          segments = segments[1].split('@');
          if (segments.length === 2) {
            return {
              cdn: provider,
              name: segments[0],
              version: segments[1],
              url,
              integrity,
              fileName,
            };
          }
        }
        return null;

      default:
        return null;
    }
  }

  private async createPullRequest(
    base: string,
    head: string,
    asset: AssetVersion
  ): Promise<PullRequest> {
    const title = `Update ${asset.name} to ${asset.version}`;

    let body = `Updates ${asset.name} to version \`${asset.version}\`.`;

    body += `\n\nThis pull request was auto-generated by [GitHub Actions](${this.options.serverUrl}/${this.options.repo}/actions/runs/${this.options.runId}).`;

    const options = {
      baseUrl: this.options.apiUrl,
    };

    const octokit = github.getOctokit(this.options.accessToken, options);

    const split = (this.options.repo ?? '/').split('/');
    const owner = split[0];
    const repo = split[1];

    const request = {
      owner,
      repo,
      title,
      head,
      base,
      body,
      maintainer_can_modify: true,
      draft: false,
    };

    if (this.options.dryRun) {
      core.info(
        `Skipped creating GitHub pull request for branch ${head} to ${base}`
      );
      return {
        number: 0,
        url: '',
      };
    }

    const response = await octokit.rest.pulls.create(request);

    core.debug(JSON.stringify(response, null, 2));

    core.info(
      `Created pull request #${response.data.number}: ${response.data.title}`
    );
    core.info(`View the pull request at ${response.data.html_url}`);

    const result = {
      number: response.data.number,
      url: response.data.html_url,
    };

    if (this.options.labels) {
      const labelsToApply = this.options.labels.split(',');

      if (labelsToApply.length > 0) {
        try {
          await octokit.rest.issues.addLabels({
            owner,
            repo,
            issue_number: result.number,
            labels: labelsToApply,
          });
        } catch (error: any) {
          core.error(
            `Failed to apply label(s) to pull request #${result.number}`
          );
          core.error(error);
        }
      }
    }

    return result;
  }

  private async execGit(
    args: string[],
    ignoreErrors: Boolean = false
  ): Promise<string> {
    let commandOutput = '';
    let commandError = '';

    const options = {
      cwd: this.options.repoPath,
      errStream: new NullWritable(),
      outStream: new NullWritable(),
      ignoreReturnCode: ignoreErrors as boolean | undefined,
      silent: ignoreErrors as boolean | undefined,
      listeners: {
        stdout: (data: Buffer) => {
          commandOutput += data.toString();
        },
        stderr: (data: Buffer) => {
          commandError += data.toString();
        },
      },
    };

    try {
      await exec.exec('git', args, options);
    } catch (error: any) {
      throw new Error(`The command 'git ${args.join(' ')}' failed: ${error}`);
    }

    if (commandError && !ignoreErrors) {
      throw new Error(commandError);
    }

    core.debug(`git std-out: ${commandOutput}`);

    if (commandError) {
      core.debug(`git std-err: ${commandError}`);
    }

    return commandOutput.trimEnd();
  }

  private async getCurrentBranch(): Promise<string> {
    return await this.execGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  private async applyAssetUpdate(
    base: string,
    fileAssetMap: Record<string, AssetVersionItem[]>,
    assetUpdate: AssetVersion,
    cdnFiles: CdnFile[]
  ): Promise<string | null> {
    core.info(`Updating ${assetUpdate.name} to ${assetUpdate.version}...`);

    let filesUpdated = 0;
    let lowestVersion = '0.0.0';

    // Apply the updates to the file system
    for (const file in fileAssetMap) {
      let content = fs.readFileSync(file, 'utf8');
      let dirty = false;

      const assetsToUpdate = fileAssetMap[file].filter(
        (a) =>
          a.cdn === assetUpdate.cdn &&
          a.name === assetUpdate.name &&
          a.version !== assetUpdate.version
      );

      for (const assetToUpdate of assetsToUpdate) {
        const latestAsset = cdnFiles.find(
          (a) => a.fileName === assetToUpdate.fileName
        );
        if (latestAsset && content.includes(assetToUpdate.url)) {
          content = content.replace(assetToUpdate.url, latestAsset.url);
          if (assetToUpdate.integrity) {
            content = content.replace(
              assetToUpdate.integrity,
              latestAsset.integrity ?? ''
            );
          }
          dirty = true;
          if (lowestVersion < assetToUpdate.version) {
            lowestVersion = assetToUpdate.version;
          }
        }
      }

      if (dirty) {
        fs.writeFileSync(file, content, { encoding: 'utf8' });
        filesUpdated++;
      }
    }

    if (filesUpdated < 1) {
      return null;
    }

    core.info(`Updated ${assetUpdate.name} version to ${assetUpdate.version}.`);

    // Configure Git
    let branchPrefix = this.options.branchPrefix;

    if (!branchPrefix) {
      branchPrefix = 'update-static-assets';
    }

    const branch =
      `${branchPrefix}/${assetUpdate.name}/${assetUpdate.version}`.toLowerCase();

    let commitMessage = this.options.commitMessage;

    if (!commitMessage) {
      commitMessage = StaticAssetUpdater.generateCommitMessage(
        assetUpdate.name,
        lowestVersion,
        assetUpdate.version
      );
    }

    if (this.options.userName) {
      await this.execGit(['config', 'user.name', this.options.userName]);
      core.info(`Updated git user name to '${this.options.userName}'`);
    }

    if (this.options.userEmail) {
      await this.execGit(['config', 'user.email', this.options.userEmail]);
      core.info(`Updated git user email to '${this.options.userEmail}'`);
    }

    if (this.options.repo) {
      await this.execGit([
        'remote',
        'set-url',
        'origin',
        `${this.options.serverUrl}/${this.options.repo}.git`,
      ]);
      await this.execGit(['fetch', 'origin'], true);
    }

    core.debug(`Branch: ${branch}`);
    core.debug(`Commit message: ${commitMessage}`);
    core.debug(`User name: ${this.options.userName}`);
    core.debug(`User email: ${this.options.userEmail}`);

    const branchExists = await this.execGit(
      ['rev-parse', '--verify', '--quiet', `remotes/origin/${branch}`],
      true
    );

    if (branchExists) {
      core.info(`The ${branch} branch already exists`);
      return null;
    }

    await this.execGit(['checkout', '-b', branch], true);
    core.info(`Created git branch ${branch}`);

    // Stage all the file system changes
    await this.execGit(['add', '.']);
    core.info(`Staged git commit for '${assetUpdate.name}' update`);

    await this.execGit(['commit', '-m', commitMessage]);

    const sha1 = await this.execGit(['log', "--format='%H'", '-n', '1']);
    const shortSha1 = sha1.replace("'", '').substring(0, 7);

    core.info(`Committed ${assetUpdate.name} update to git (${shortSha1})`);

    if (!this.options.dryRun && this.options.repo) {
      await this.execGit(['push', '-u', 'origin', branch], true);
      core.info(`Pushed changes to repository (${this.options.repo})`);
    }

    return branch;
  }
}

interface Asset {
  cdn: CdnProvider;
  name: string;
}

interface AssetVersion extends Asset {
  version: string;
}

interface AssetVersionItem extends AssetVersion {
  url: string;
  integrity: string | null;
  fileName: string;
}

interface PullRequest {
  number: number;
  url: string;
}

class NullWritable extends Writable {
  _write(
    _chunk: any,
    _encoding: string,
    callback: (error?: Error | null) => void
  ): void {
    callback();
  }
  _writev(
    _chunks: { chunk: any; encoding: string }[],
    callback: (error?: Error | null) => void
  ): void {
    callback();
  }
}
