import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { Presentation, PresentationFile } from '@oai/artifact-tool';

const workspaceDir='D:/All Work/TM-X React';
const buildDir=path.join(workspaceDir,'.codex-ppt-build');
const finalPath=path.join(workspaceDir,'output','Auto_Sorter_Two_Actions.pptx');
const skillDir='C:/Users/User/.codex/plugins/cache/openai-primary-runtime/presentations/26.904.11930/skills/presentations';
const pythonExecutable='C:/Users/User/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const {finalizePresentation}=await import(pathToFileURL(path.join(skillDir,'container_tools/artifact_tool_utils.mjs')).href);
await fs.mkdir(buildDir,{recursive:true});await fs.mkdir(path.dirname(finalPath),{recursive:true});
const logo=await sharp(path.join(buildDir,'source-slides','slide-33.png')).extract({left:1068,top:38,width:190,height:53}).png().toBuffer();

const deck=Presentation.create({slideSize:{width:1280,height:720}});
const C={navy:'#082A68',peach:'#F8E9E2',orange:'#C25418',orangePale:'#FBE8DC',blue:'#4B9BD3',bluePale:'#E7F4FB',body:'#1B3157',gray:'#5B6471',line:'#C8D0D7',white:'#FFFFFF'};
const noLine={fill:'none',width:0};
function box(s,x,y,w,h,fill='none',stroke='none',sw=0,r=0){return s.shapes.add({geometry:r?'roundRect':'rect',position:{left:x,top:y,width:w,height:h},fill,line:{style:'solid',fill:stroke,width:sw},...(r?{borderRadius:r}:{})})}
function txt(s,value,x,y,w,h,size=22,color=C.navy,bold=false,align='left',vertical='middle'){
 const sh=s.shapes.add({geometry:'textbox',position:{left:x,top:y,width:w,height:h},fill:'none',line:noLine});
 sh.text=value;sh.text.style={typeface:'Arial',fontSize:size,bold,color,alignment:align,verticalAlignment:vertical,autoFit:'shrinkText',wrap:'square',insets:{left:0,right:0,top:0,bottom:0}};return sh;
}
function base(s,num,title,subtitle){
 s.background.fill=C.white;
 txt(s,'Actions',92,64,150,53,34,C.navy,true);
 box(s,250,64,350,52,C.peach);txt(s,`Action ${num}`,273,70,315,42,27,'#111111',true);
 s.images.add({blob:logo,contentType:'image/png',position:{left:1068,top:37,width:190,height:53},fit:'contain',alt:'Analog Devices and partner logos from supplied presentation'});
 txt(s,title,91,137,1110,56,36,C.navy,true);
 txt(s,subtitle,92,194,1090,37,22,C.gray);
 box(s,0,704,1280,16,'#0A67A9');
}
function actionStep(s,x,num,title,body,accent,pale){
 box(s,x,248,352,269,pale,C.line,1,8);
 box(s,x,248,352,52,accent);
 txt(s,num,x+22,254,37,40,29,C.white,true,'center');
 txt(s,title,x+68,256,275,38,25,C.white,true);
 txt(s,body,x+24,328,304,142,24,C.body,false,'left','top');
}

// Action 1: replace manual Excel recording with automatic database records.
{
 const s=deck.slides.add();
 base(s,'01','Automate Data Capture and Storage','Record each ALPL measurement directly as the machine runs.');
 actionStep(s,70,'1','Measure','TM-X produces a measurement and camera image for each part.',C.orange,C.orangePale);
 actionStep(s,465,'2','Capture','The system links the reading and image to the correct part and checks the result.',C.blue,C.bluePale);
 actionStep(s,860,'3','Store','The database keeps the value, result, image, time, and operator together.',C.blue,C.bluePale);
 box(s,70,545,1140,2,C.line);
 txt(s,'What this removes',70,567,330,34,24,C.navy,true);
 txt(s,'Manual copying into separate Excel logs',70,607,500,44,22,C.body);
 txt(s,'What this enables',645,567,330,34,24,C.navy,true);
 txt(s,'Each result can be reviewed with its original image',645,607,525,44,22,C.body);
 s.speakerNotes.textFrame.setText('Based on the supplied deck: slide 33 says readings and images are kept together; slides 36–37 describe automatic receiving, validation, and storage; slide 42 includes measurement time and operator fields.');
}

// Action 2: make specifications and records consistent and accessible.
{
 const s=deck.slides.add();
 base(s,'02','Standardize and Centralize Data Access','Keep one consistent set of ALPL specifications and measurement records.');
 box(s,70,247,540,315,C.orangePale,C.line,1,8);
 box(s,70,247,540,54,C.orange);
 txt(s,'Standardize the data',94,255,490,38,26,C.white,true);
 txt(s,'Use consistent fields and naming across ALPL and part sizes.\n\nMaintain specifications in one place, with changes recorded.',95,330,486,192,24,C.body,false,'left','top');
 box(s,670,247,540,315,C.bluePale,C.line,1,8);
 box(s,670,247,540,54,C.blue);
 txt(s,'Make records accessible',695,255,485,38,26,C.white,true);
 txt(s,'Authorized users can search results from different work areas.\n\nFilter, review, and export the same current records.',695,330,480,192,24,C.body,false,'left','top');
 box(s,70,590,1140,70,'#F4F7FA','none',0,7);
 txt(s,'Operators, planners, and quality teams work from the same up-to-date information.',94,601,1094,48,25,C.navy,true,'center');
 s.speakerNotes.textFrame.setText('Based on the supplied deck: slide 34 describes centrally maintained specifications, controlled corrections, and history; slide 35 describes export; slides 40–41 describe shared filtered and summarized data. Access should be limited to authorized users.');
}

const candidatePath=path.join(buildDir,'two-actions-candidate.pptx');
await (await PresentationFile.exportPptx(deck)).save(candidatePath);
for(let i=0;i<2;i++){
 const png=await deck.export({slide:deck.slides.items[i],format:'png',scale:1});
 await fs.writeFile(path.join(buildDir,`two-actions-preview-${i+1}.png`),new Uint8Array(await png.arrayBuffer()));
}
const result=await finalizePresentation({
 explicitTotalSlideCount:2,requiredNativeTableOwnerSlides:[],requiredNativeChartOwnerSlides:[],
 workspaceDir,candidatePath,finalPath,pythonExecutable,
 integrityValidatorPath:path.join(skillDir,'container_tools/inspect_presentation_package_integrity.py'),
 layoutValidatorPath:path.join(skillDir,'container_tools/inspect_presentation_layout_geometry.py'),
 layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-heading-fit'],
 fontPolicy:{basis:'design',families:['Arial']},verifyArtifactToolImport:true,
 receiptPath:path.join(buildDir,'two-actions.validation.json'),
});
console.log(JSON.stringify({finalPath,result},null,2));
