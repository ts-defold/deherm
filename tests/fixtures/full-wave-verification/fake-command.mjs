const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  values.set(process.argv[index], process.argv[index + 1] ?? "");
}

if (values.has("--stdout")) process.stdout.write(`${values.get("--stdout")}\n`);
if (values.has("--stderr")) process.stderr.write(`${values.get("--stderr")}\n`);
const delay = Number(values.get("--delay") ?? 0);
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
process.exitCode = Number(values.get("--exit") ?? 0);
