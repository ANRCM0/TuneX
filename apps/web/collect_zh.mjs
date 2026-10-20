import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
const ROOT="/workspace/111/relayx/apps/web/src";
const CJK=/[\u4e00-\u9fff]/;
function walk(d,o=[]){for(const n of fs.readdirSync(d)){const p=path.join(d,n);const st=fs.statSync(p);if(st.isDirectory())walk(p,o);else if(/\.(ts|tsx)$/.test(n))o.push(p);}return o;}
const found=new Set();
for(const file of walk(ROOT)){
  if(file.includes("/lib/i18n/"))continue;
  const text=fs.readFileSync(file,"utf8");
  if(!CJK.test(text))continue;
  const sf=ts.createSourceFile(file,text,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TSX);
  const visit=(n)=>{
    if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)){
      const v=n.text.trim();
      if(CJK.test(v)&&v.length>1)found.add(v);
      return;
    }
    if(ts.isJsxText(n)){
      const v=n.getText(sf).trim();
      if(CJK.test(v))found.add(v);
      return;
    }
    ts.forEachChild(n,visit);
  };
  visit(sf);
}
console.log(JSON.stringify([...found].sort(),null,0));
