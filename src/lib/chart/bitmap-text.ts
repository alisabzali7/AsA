/** Deterministic 5x7 ASCII labels for the dependency-free PNG rasterizer.
 * No downloaded fonts, browser canvas or platform font substitution. Canonical
 * identifiers/level kinds are ASCII; full localized prose remains in the SVG,
 * caption and structured evidence, not silently transliterated here.
 */
const FONT: Record<string, number[]> = {
  "0":[62,81,73,69,62],"1":[0,66,127,64,0],"2":[66,97,81,73,70],"3":[33,65,69,75,49],"4":[24,20,18,127,16],
  "5":[39,69,69,69,57],"6":[60,74,73,73,48],"7":[1,113,9,5,3],"8":[54,73,73,73,54],"9":[6,73,73,41,30],
  A:[126,17,17,17,126],B:[127,73,73,73,54],C:[62,65,65,65,34],D:[127,65,65,34,28],E:[127,73,73,73,65],
  F:[127,9,9,9,1],G:[62,65,73,73,122],H:[127,8,8,8,127],I:[0,65,127,65,0],J:[32,64,65,63,1],
  K:[127,8,20,34,65],L:[127,64,64,64,64],M:[127,2,12,2,127],N:[127,4,8,16,127],O:[62,65,65,65,62],
  P:[127,9,9,9,6],Q:[62,65,81,33,94],R:[127,9,25,41,70],S:[70,73,73,73,49],T:[1,1,127,1,1],
  U:[63,64,64,64,63],V:[31,32,64,32,31],W:[63,64,56,64,63],X:[99,20,8,20,99],Y:[7,8,112,8,7],Z:[97,81,73,69,67],
  " ":[0,0,0,0,0],".":[0,96,96,0,0],":":[0,54,54,0,0],"-":[8,8,8,8,8],"/":[32,16,8,4,2],
  "|":[0,0,127,0,0],"%":[35,19,8,100,98],"+":[8,8,62,8,8],"?":[2,1,81,9,6],"_":[64,64,64,64,64],
};
export function bitmapText(text: string, x: number, y: number, pixel: (x:number,y:number)=>void, width: number, scale=1): void {
  for(const c of text.toUpperCase()) {
    if(x+5*scale>width) break;
    const glyph=FONT[c]??FONT["?"];
    for(let col=0;col<5;col++) for(let row=0;row<7;row++) if(glyph[col]&(1<<row))
      for(let dx=0;dx<scale;dx++) for(let dy=0;dy<scale;dy++) pixel(x+col*scale+dx,y+row*scale+dy);
    x+=6*scale;
  }
}
