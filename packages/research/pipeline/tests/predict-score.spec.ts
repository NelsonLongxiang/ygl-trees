import {describe,it,expect} from "vitest";
import {predictionProbability,predictionScore,summarizePredictions} from "../src/predict-score";
const row=(confidence:unknown,outcome:string,channel="ch-a",note:string|null=null)=>({channel,outcome,...predictionScore(confidence,outcome,note)});
describe("#158 prediction scores",()=>{
 it("normalizes numeric probabilities and percentages without interpreting evidence grades",()=>{
  for(const [input,p] of [["0.8",0.8],["80",0.8],["80%",0.8],["1",1],["1%",0.01],["0",0],["100",1],[" .5 ",0.5],["1e-1",0.1]] as const)expect(predictionProbability(input)).toBe(p);
  for(const input of [null,undefined,""," ","A","B","C","ND","NaN","Infinity","-1","101%","0.8junk","0x10"])expect(predictionProbability(input)).toBeNull();
 });
 it("computes fixture Brier and hit rate from claim probability only",()=>{
  const rows=[row("0.8","1"),row("0.6","0"),row("0.7","ND")];
  expect(rows.map(r=>r.brier_calc)).toEqual([0.04,0.36,null]);
  expect(summarizePredictions(rows)).toEqual([{channel:"ch-a",settled:2,nd:1,open:0,no_p:0,hit_rate:0.5,brier_mean:0.2}]);
 });
 it("excludes unknown probabilities, ND and open rows from both denominators",()=>{
  const rows=[row("0.8","1"),row("A","0"),row("C","ND"),row("0.2","未结算")];
  expect(summarizePredictions(rows)[0]).toEqual({channel:"ch-a",settled:2,nd:1,open:1,no_p:2,hit_rate:1,brier_mean:0.04});
  expect(summarizePredictions([row("B","1"),row("0.9","ND"),row("0.1","未结算")])[0]).toMatchObject({settled:1,nd:1,open:1,no_p:1,hit_rate:null,brier_mean:null});
 });
 it("returns null rather than zero for no settled predictions and keeps channels separate",()=>{
  expect(summarizePredictions([row("0.8","ND"),row("0.2","未结算")])[0]).toMatchObject({settled:0,nd:1,open:1,hit_rate:null,brier_mean:null});
  expect(summarizePredictions([row("0.8","1","b"),row("0.2","0","a")]).map(r=>r.channel)).toEqual(["a","b"]);
  expect(summarizePredictions([])).toEqual([]);
 });
 it("uses the 0.5 decision boundary without counting wrong high or low calls as hits",()=>{
  expect(summarizePredictions([row("0.5","1"),row("0.5","0"),row("0.49","0"),row("0.49","1")])[0].hit_rate).toBe(0.5);
 });
 it("marks only note discrepancies strictly greater than 0.005",()=>{
  expect(predictionScore("0.8","1","0.9")).toMatchObject({brier_calc:0.04,brier_mismatch:true});
  for(const n of ["0.04","0.045","0.035"])expect(predictionScore("0.8","1",n).brier_mismatch).toBe(false);
  expect(predictionScore("0.8","1","0.045001").brier_mismatch).toBe(true);
  expect(predictionScore("A","1","0.9").brier_mismatch).toBe(false);
  expect(predictionScore("0.8","ND","0.9").brier_calc).toBeNull();
  expect(predictionScore("0.8","未结算",null).brier_calc).toBeNull();
 });
});
