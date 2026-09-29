import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes, randomUUID, scrypt } from "node:crypto";
import { z } from "zod";
import type { DB } from "../db.ts";
import type { Capability } from "../domain/access.ts";
import { pageQuery } from "../domain/security.ts";
import { annotationReviews, claimAnnotationReview, AnnotationIngestion, ingestAnnotations, nextAnnotation, prefetchAnnotations, releaseAnnotationBuffers, submitAnnotation, annotationHeartbeat, annotationSource, annotationStats, annotationCoverage, annotationQualityReport, AdjudicationInput, adjudicateAnnotation, releaseAnnotationDataset, annotationJson } from "./data-verification.ts";
import {annotationLibrary,annotationLibrarySource,markAnnotationLibrary} from "./annotation-library.ts";
import { sendAnnotationContent } from "./annotation-content.ts";
import { HttpError } from "./inspections.ts";

type Auth = (cap: Capability) => (req: FastifyRequest,reply: FastifyReply) => Promise<unknown>;
export function registerDataVerificationRoutes(app: FastifyInstance, db: DB, auth: Auth) {
  app.get("/api/v1/verification/library",{onRequest:auth("verification.work")},async req=>annotationLibrary(db,req.user!,req.query));
  app.post("/api/v1/verification/library/:id/mark",{onRequest:auth("verification.work")},async req=>markAnnotationLibrary(db,req.user!,(req.params as any).id,req.body));
  for(const type of ["content","fragment"] as const)app.get(`/api/v1/verification/library/:id/${type}/:side`,{onRequest:auth("verification.work")},async(req,reply)=>{
    const source=await annotationLibrarySource(db,req.user!,(req.params as any).id,Number((req.params as any).side));
    return sendAnnotationContent(req,reply,source,type==='fragment');
  });
  app.post("/api/v1/verification/assignments/next", { onRequest: auth("verification.work") }, async (req) => nextAnnotation(db,req.user!.id));
  app.post("/api/v1/verification/assignments/prefetch", {onRequest:auth("verification.work")},async req=>prefetchAnnotations(db,req.user!.id));
  app.post("/api/v1/verification/assignments/release-buffer", {onRequest:auth("verification.work")},async req=>releaseAnnotationBuffers(db,req.user!.id));
  app.post("/api/v1/verification/assignments/:id/heartbeat", { onRequest: auth("verification.work") }, async (req) => {
    const body = z.object({ token:z.string().min(20).max(100) }).strict().parse(req.body);
    return annotationHeartbeat(db,req.user!.id,(req.params as any).id,body.token);
  });
  app.post("/api/v1/verification/assignments/:id/labels", { onRequest: auth("verification.work") }, async (req) => submitAnnotation(db,req.user!.id,(req.params as any).id,req.body));
  for (const type of ["content","fragment"] as const) {
    app.get(`/api/v1/verification/assignments/:id/${type}/:side`, { onRequest: auth("verification.work") }, async (req,reply) => {
      const source = await annotationSource(db,req.user!.id,(req.params as any).id,Number((req.params as any).side));
      return sendAnnotationContent(req,reply,source,type === "fragment");
    });
  }
  app.get("/api/v1/verification/me/stats", { onRequest:auth("verification.work") }, async (req) => annotationStats(db,req.user!.id));
  app.get("/api/v1/verification/coverage", { onRequest:auth("verification.manage") }, async () => annotationCoverage(db));
  app.get("/api/v1/verification/quality", { onRequest:auth("verification.manage") }, async () => annotationQualityReport(db));
  app.post("/api/v1/verification/ingestions", { onRequest:auth("verification.manage") }, async (req) => ingestAnnotations(db,req.user!.id,AnnotationIngestion.parse(req.body)));
  app.get("/api/v1/verification/reviews", {onRequest:auth("verification.manage")}, async(req)=>annotationReviews(db,req.user!.id));
  app.post("/api/v1/verification/tasks/:id/review", {onRequest:auth("verification.manage")}, async(req)=>claimAnnotationReview(db,req.user!.id,(req.params as any).id));
  app.post("/api/v1/verification/tasks/:id/adjudications", { onRequest:auth("verification.manage") }, async (req) => adjudicateAnnotation(db,req.user!.id,(req.params as any).id,AdjudicationInput.parse(req.body)));
  app.post("/api/v1/verification/datasets/release", { onRequest:auth("verification.manage") }, async (req) => releaseAnnotationDataset(db,req.user!.id));
  app.get("/api/v1/verification/datasets/:id/items", { onRequest:auth("verification.export") }, async (req) => {
    const { limit,offset } = pageQuery(100).parse(req.query ?? {});
    const dataset = await db.get<any>("select manifest_json from verification_datasets where id=$1",[(req.params as any).id]);
    if (!dataset) throw new HttpError(404,"Набор не найден");
    const items = await db.all<any>("select snapshot_json from verification_dataset_items where dataset_id=$1 order by task_id limit $2 offset $3",[(req.params as any).id,limit,offset]);
    return { manifest:annotationJson(dataset.manifest_json),items:items.map((r) => annotationJson(r.snapshot_json)),limit,offset };
  });
  app.post("/api/v1/admin/verifiers", { onRequest:auth("users.admin") }, async (req) => {
    const body = z.object({ login:z.string().regex(/^[a-zA-Z0-9._-]{3,80}$/),name:z.string().min(1).max(100),password:z.string().min(12).max(200) }).strict().parse(req.body);
    const id = randomUUID(), salt = randomBytes(16).toString("hex");
    const key = await new Promise<Buffer>((res,rej) => scrypt(body.password,salt,32,(e,k) => e ? rej(e) : res(k)));
    const result = await db.run("insert into users(id,login,name,role,password_hash) values($1,$2,$3,'verifier',$4) on conflict(login) do nothing returning id",[id,body.login,body.name,`${salt}:${key.toString("hex")}`]);
    if (!result.rowCount) throw new HttpError(409,"Логин уже занят");
    return { id,login:body.login,name:body.name,role:"verifier" };
  });
}
