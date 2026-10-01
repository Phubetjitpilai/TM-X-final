import fs from 'node:fs/promises';
import { FileBlob, PresentationFile } from '@oai/artifact-tool';
const source='D:/All Work/TM-X React/output/Auto_Sorter_Actions_Data_and_PowerBI_2_Slides_v3.pptx';
const out='D:/All Work/TM-X React/.codex-presentation-build';
const p=await PresentationFile.importPptx(await FileBlob.load(source));
if(p.slides.items.length!==2) throw new Error(`Expected 2 slides, got ${p.slides.items.length}`);
for(let i=0;i<2;i++){
 const im=await p.export({slide:p.slides.items[i],format:'png',scale:1});
 await fs.writeFile(`${out}/final-v3-slide-${i+1}.png`,new Uint8Array(await im.arrayBuffer()));
}
console.log('Rendered 2 final slides');
