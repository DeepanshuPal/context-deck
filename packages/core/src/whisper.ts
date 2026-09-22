import {spawn} from "node:child_process";
import {access, readFile} from "node:fs/promises";
import {constants} from "node:fs";
import {dirname, join, parse} from "node:path";

export interface WhisperOptions { binary: string; model: string; media: string; outputDirectory: string; language?: string; }

export async function transcribeLocally(options: WhisperOptions): Promise<string> {
  await Promise.all([access(options.binary, constants.X_OK), access(options.model), access(options.media)]);
  const stem = parse(options.media).name;
  const outputBase = join(options.outputDirectory, stem);
  const args = ["-m", options.model, "-f", options.media, "-osrt", "-of", outputBase];
  if (options.language) args.push("-l", options.language);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.binary, args, {cwd: dirname(options.media), stdio: ["ignore", "pipe", "pipe"]});
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`whisper.cpp exited ${code}: ${stderr.slice(-500)}`)));
  });
  return readFile(`${outputBase}.srt`, "utf8");
}
