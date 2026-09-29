import fs from 'node:fs/promises';
import { FileBlob, PresentationFile } from '@oai/artifact-tool';
const src='D:/All Work/TM-X React/output/Auto_Sorter_Two_Actions.pptx';
const ppt=await PresentationFile.importPptx(await FileBlob.load(src));
if(ppt.slides.items.length!==2)throw new Error('Expected 2 slides');
for(let i=0;i<2;i++){
  const png=await ppt.export({slide:ppt.slides.items[i],format:'png',scale:1});
  await fs.writeFile(`D:/All Work/TM-X React/.codex-ppt-build/two-actions-final-${i+1}.png`,new Uint8Array(await png.arrayBuffer()));
}
console.log('Rendered final 2-slide deck');
