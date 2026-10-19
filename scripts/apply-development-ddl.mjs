import fs from "node:fs/promises";
import {bundleT01Sources,connectDevelopment,newFixture} from "./lib/t01-development.mjs";
const name=process.argv[2];
const allowed=new Set(["20260921_quote_features.sql", "20260921_quote_templates.sql"]);
if(!allowed.has(name))throw Error("Unregistered development DDL");
const env=await connectDevelopment(await bundleT01Sources(),newFixture());
const client=await env.dependencies.pool.connect();
try {
 await client.query("BEGIN");await client.query("SET LOCAL lock_timeout = '5s'");
 const countSql="SELECT (SELECT count(*) FROM public.deals) deals,(SELECT count(*) FROM public.meetings) meetings,(SELECT count(*) FROM public.quotes) quotes,(SELECT count(*) FROM public.quote_lines) lines";
 const before=await client.query(countSql);
 await client.query(await fs.readFile(`prisma/development/${name}`,"utf8"));
 const after=await client.query(countSql);
 if(JSON.stringify(before.rows)!==JSON.stringify(after.rows))throw Error("Existing row counts changed");
 await client.query("COMMIT");console.log("DEVELOPMENT_DDL_APPLIED_EXISTING_ROW_COUNTS_UNCHANGED",name);
}catch(e){await client.query("ROLLBACK");console.error("DEVELOPMENT_DDL_FAILED",e.code??e.name);process.exitCode=1}
finally{client.release();await env.close()}
