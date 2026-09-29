import fs from 'node:fs/promises';
import path from 'node:path';
import { Presentation, PresentationFile } from '@oai/artifact-tool';
import { pathToFileURL } from 'node:url';

const workspaceDir = 'D:/All Work/TM-X React';
const SKILL_DIR = 'C:/Users/User/.codex/plugins/cache/openai-primary-runtime/presentations/26.904.11930/skills/presentations';
const TMP_DIR = path.join(workspaceDir, '.codex-presentation-build');
const FINAL_PPTX = path.join(workspaceDir, 'output', 'Auto_Sorter_Actions_Data_and_PowerBI_2_Slides.pptx');
const RUNTIME_PYTHON = 'C:/Users/User/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const { finalizePresentation } = await import(pathToFileURL(path.join(SKILL_DIR, 'container_tools/artifact_tool_utils.mjs')).href);
await fs.mkdir(TMP_DIR, {recursive: true});
await fs.mkdir(path.dirname(FINAL_PPTX), {recursive: true});
const logo = new Uint8Array(await fs.readFile(path.join(TMP_DIR, 'source', 'existing-logo.png')));
const p = Presentation.create({slideSize: {width: 1280, height: 720}});
const NAVY = '#002060';
const BLUE = '#1166A3';
const ORANGE = '#C9571B';
const BEIGE = '#F5E4DB';
const BODY = '#1F365C';
const MUTED = '#5D687B';
const RULE = '#C6D2DF';

function rect(slide, x, y, w, h, fill) {
  return slide.shapes.add({geometry:'rect', position:{left:x,top:y,width:w,height:h}, fill, line:{fill:'none',width:0}});
}
function text(slide, value, x,y,w,h, size, color, bold=false) {
  const s = slide.shapes.add({geometry:'textbox',position:{left:x,top:y,width:w,height:h},fill:'none',line:{fill:'none',width:0}});
  s.text = value;
  s.text.style = {typeface:'Aptos',fontSize:size,bold,color,autoFit:'none'};
  return s;
}
function base(actionTitle) {
  const slide = p.slides.add();
  slide.background.fill = '#FFFFFF';
  text(slide,'Actions',90,62,160,65,36,NAVY,true);
  rect(slide,250,64,760,55,BEIGE);
  text(slide,actionTitle,270,68,725,52,26,'#181818',true);
  slide.images.add({blob:logo,contentType:'image/png',alt:'Analog Devices and partner logos',fit:'contain',position:{left:1070,top:43,width:178,height:50}});
  rect(slide,0,699,1280,21,BLUE);
  return slide;
}
function steps(slide, items, closing) {
  const xs = [90,470,850];
  items.forEach((item,i) => {
    const x=xs[i];
    text(slide,String(i+1).padStart(2,'0'),x,230,85,62,48,ORANGE,true);
    text(slide,item.heading,x,300,320,55,28,NAVY,true);
    text(slide,item.body,x,366,320,132,22,BODY,false);
  });
  rect(slide,445,236,1.5,290,RULE);
  rect(slide,825,236,1.5,290,RULE);
  rect(slide,90,564,1120,1.5,RULE);
  text(slide,closing,90,592,1120,60,26,NAVY,true);
}

let slide=base('Automate Data Capture and Storage');
steps(slide,[
  {heading:'Enter part details',body:'The operator enters ALPL and part information in the web app.'},
  {heading:'Measure with TM-X',body:'TM-X sends the measurement values and part image.'},
  {heading:'Save immediately',body:'The system stores the result with the correct part record.'},
],'Each measured part has a complete record.');
slide.speakerNotes.textFrame.setText('Action: operator enters part information on the web; TM-X supplies values and image; the system stores each result immediately.');

slide=base('Standardize and Centralize Data Access');
steps(slide,[
  {heading:'Connect the records',body:'Part details and measurements stay linked in one relational database.'},
  {heading:'Update Power BI daily',body:'The quality summary refreshes from the database each day.'},
  {heading:'See the quality picture',body:'Teams see Good/Fail counts by part and package size, plus yield trends.'},
],'One daily view of results for production and quality teams.');
slide.speakerNotes.textFrame.setText('Power BI is refreshed daily, so the dashboard is a daily summary rather than a live measurement feed. The source deck describes Good/Fail counts by package size and part number and a yield trend.');

const candidatePath = path.join(TMP_DIR,'actions-candidate.pptx');
await (await PresentationFile.exportPptx(p)).save(candidatePath);
for (let i=0;i<p.slides.items.length;i++) {
  const preview=await p.export({slide:p.slides.items[i],format:'png',scale:1});
  await fs.writeFile(path.join(TMP_DIR,`actions-preview-${i+1}.png`),new Uint8Array(await preview.arrayBuffer()));
}
const result=await finalizePresentation({
  workspaceDir,
  candidatePath,
  finalPath:FINAL_PPTX,
  pythonExecutable:RUNTIME_PYTHON,
  integrityValidatorPath:path.join(SKILL_DIR,'container_tools/inspect_presentation_package_integrity.py'),
  layoutValidatorPath:path.join(SKILL_DIR,'container_tools/inspect_presentation_layout_geometry.py'),
  layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-heading-fit'],
  explicitTotalSlideCount:2,
  requiredNativeTableOwnerSlides:[],
  requiredNativeChartOwnerSlides:[],
  fontPolicy:{basis:'design',families:['Aptos']},
  verifyArtifactToolImport:true,
  receiptPath:path.join(TMP_DIR,'actions.validation.json'),
});
console.log(JSON.stringify({finalPath:FINAL_PPTX,result},null,2));
