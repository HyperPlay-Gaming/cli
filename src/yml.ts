import { ReleaseConfig } from "./types";
import fs from 'fs';
import YAML from 'yaml';
import { FlagOutput } from "@oclif/core/lib/interfaces";

/* eslint-disable-next-line */
export function parseYml(args: { [name: string]: any; }, flags: FlagOutput): ReleaseConfig | undefined {
  //TODO: add zod validation
  let config: ReleaseConfig;
  const flagPath = flags['yml-path']
  const ymlPath = flagPath ? flagPath : 'hyperplay.yml'
  // using hyperplay.yml 
  if (fs.existsSync(ymlPath)) {
    const data = fs.readFileSync(ymlPath, 'utf8');
    config = YAML.parse(data);

    // override yaml if cli args are passed for acct, project, or release
    if (args.account) {
      config.account = args.account
    }
    if (args.project) {
      config.project = args.project
    }
    if (args.release) {
      config.release = args.release
    }
  }
  else {
    return undefined
  }
  return config
}