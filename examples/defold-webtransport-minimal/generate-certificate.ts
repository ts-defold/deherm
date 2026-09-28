const command = new Deno.Command("openssl", {
  args: [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    "key.pem",
    "-out",
    "cert.pem",
    "-days",
    "14",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1",
  ],
  stdout: "piped",
  stderr: "piped",
});

const generated = await command.output();
if (!generated.success) {
  throw new Error(`OpenSSL certificate generation failed: ${new TextDecoder().decode(generated.stderr).trim()}`);
}

const der = await new Deno.Command("openssl", {
  args: ["x509", "-in", "cert.pem", "-outform", "DER"],
  stdout: "piped",
  stderr: "piped",
}).output();
if (!der.success) {
  throw new Error(`OpenSSL certificate conversion failed: ${new TextDecoder().decode(der.stderr).trim()}`);
}

const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", der.stdout));
const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
console.log(`certificate_sha256 = ${hex}`);
console.log("Copy the hex value into main/client.script or set the component property in Defold.");
