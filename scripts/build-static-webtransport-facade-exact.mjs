import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { transform } from "esbuild";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const shermes = args.get("--shermes");
const outputDirectory = args.get("--output-dir");
assert.ok(shermes, "--shermes is required");
assert.ok(outputDirectory, "--output-dir is required");

const facadePath = "extensions/defold-webtransport/defold_webtransport/webtransport/static/WebTransport.ts";
const facade = (await readFile(facadePath, "utf8"))
  .replace(/^import .*;\n/gmu, "")
  .replace(/^export /gmu, "")
  .replace(/\bNativeWebTransportSpec\b/gu, "NativeWebTransportLowLevelSpec")
  .replace(/\bNativeWebTransport\b/gu, "NativeWebTransportLowLevel");
const certificate = `[${Array.from({ length: 32 }, (_, index) => index).join(",")}]`;

const facadeSource = `const __provider=globalThis.__defoldModulesV1.NativeWebTransport;
const NativeWebTransportLowLevel={
  open:(url,certificate,uni,bidi)=>__provider.open(url,new Uint8Array(certificate),uni,bidi),
  state:(handle)=>__provider.state(handle),
  maxDatagramBytes:(handle)=>__provider.maxDatagramBytes(handle),
  openBidirectionalStream:(handle,request)=>__provider.openBidirectionalStream(handle,request),
  openUnidirectionalStream:(handle,request)=>__provider.openUnidirectionalStream(handle,request),
  writeStream:(handle,stream,bytes,fin)=>__provider.writeStream(handle,stream,new Uint8Array(bytes),fin),
  resetStream:(handle,stream,code)=>__provider.resetStream(handle,stream,code),
  stopSending:(handle,stream,code)=>__provider.stopSending(handle,stream,code),
  trySendDatagram:(handle,bytes)=>__provider.trySendDatagram(handle,new Uint8Array(bytes)),
  poll:(handle,output)=>{const bytes=new Uint8Array(output.length);const status=__provider.poll(handle,bytes);for(let index=0;index<bytes.length;++index)output[index]=bytes[index];return status;},
  close:(handle,code,reason)=>__provider.close(handle,code,reason),
  destroy:(handle)=>__provider.destroy(handle)
};
const __nativePumps=[];
function registerNativeModulePump(pump){__nativePumps.push(pump);return()=>{const index=__nativePumps.indexOf(pump);if(index>=0)__nativePumps.splice(index,1);};}
globalThis.__dehermNativeModulesTickV1=(dt)=>{for(const pump of __nativePumps.slice())pump(dt);};
${facade}
let mismatches=0;
let readyObserved=false,datagramWriteObserved=false,datagramReadObserved=false,streamWriteObserved=false,closedObserved=false,reported=false;
const certificate=${certificate};
const transport=new WebTransport("https://host/game/✓",{serverCertificateHashes:[{algorithm:"sha-256",value:certificate}],anticipatedConcurrentIncomingUnidirectionalStreams:64,anticipatedConcurrentIncomingBidirectionalStreams:8});
const datagramReader=transport.datagrams.readable.getReader();
datagramReader.read().then((result)=>{if(result.done||!result.value||result.value.length!==3||result.value[0]!==5||result.value[2]!==7)++mismatches;datagramReadObserved=true;});
transport.ready.then(()=>{
  readyObserved=true;
  transport.datagrams.writable.getWriter().write([9,8,7]).then(()=>{datagramWriteObserved=true;});
  transport.createBidirectionalStream().then((stream)=>{
    stream.writable.getWriter().write([4,3]).then(()=>{streamWriteObserved=true;});
  });
});
transport.closed.then((info)=>{if(info.closeCode!==44||info.reason!=="done")++mismatches;closedObserved=true;});
class StaticWebTransportFacadeExactApp{
  init(){}
  update(_dt){if(!reported&&readyObserved&&datagramWriteObserved&&datagramReadObserved&&streamWriteObserved&&closedObserved){reported=true;globalThis.__defoldHostV1.log("info","static-webtransport-facade-evidence:"+mismatches);}}
  final(){}
}
globalThis.__defoldAppV1=new StaticWebTransportFacadeExactApp();
`;
await mkdir(outputDirectory, { recursive: true });
const facadeInput = path.join(outputDirectory, "static-webtransport-facade-exact.js");
const facadeOutput = path.join(outputDirectory, "static-webtransport-facade-exact.c");
const loweredFacade = await transform(facadeSource, { loader: "ts", format: "iife", target: "es2022", minify: false });
await writeFile(facadeInput, loweredFacade.code);
function compile(arguments_) {
  const result = spawnSync(shermes, arguments_, { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout || `shermes terminated by ${result.signal}`);
}
compile(["-strict", "-O", "-emit-c", "-exported-unit=deherm_static_webtransport_facade_exact", facadeInput, "-o", facadeOutput]);
console.log(`Static Hermes emitted executable high-level facade ${facadeOutput}`);
