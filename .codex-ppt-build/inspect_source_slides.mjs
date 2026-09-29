import fs from 'node:fs/promises';
import { FileBlob, PresentationFile } from '@oai/artifact-tool';
const src='D:/All Work/TM-X React/.codex-ppt-build/source-no-video.pptx';
const out='D:/All Work/TM-X React/.codex-ppt-build/source-slides';
await fs.mkdir(out,{recursive:true});
const ppt=await PresentationFile.importPptx(await FileBlob.load(src));
console.log('Imported',ppt.slides.items.length,'slides');
for(let n=33;n<=42;n++){
  const img=await ppt.export({slide:ppt.slides.items[n-1],format:'png',scale:1});
  await fs.writeFile(`${out}/slide-${n}.png`,new Uint8Array(await img.arrayBuffer()));
  console.log('Rendered',n);
}
