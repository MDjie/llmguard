package guardllm
import("encoding/json";"os";"testing")
func TestSharedGatewayCanonicalVectors(t *testing.T){
  raw,err:=os.ReadFile("../contracts/golden/gateway-v2.json");if err!=nil{t.Fatal(err)}
  var vectors struct{
    Valid []struct{Name,InputJson,Canonical,Sha256 string}
    Invalid []struct{Name,InputJson string}
    Routing []struct{TenantId,ApplicationId,BusinessKey string;Bucket uint32}
  }
  if err=json.Unmarshal(raw,&vectors);err!=nil{t.Fatal(err)}
  for _,v:=range vectors.Valid{t.Run(v.Name,func(t *testing.T){
    actual,err:=CanonicalizeJSON([]byte(v.InputJson));if err!=nil{t.Fatal(err)};if actual!=v.Canonical{t.Fatalf("canonical mismatch: %q != %q",actual,v.Canonical)}
    digest,err:=CanonicalSHA256([]byte(v.InputJson));if err!=nil||digest!=v.Sha256{t.Fatal("digest mismatch")}
  })}
  for _,v:=range vectors.Invalid{t.Run(v.Name,func(t *testing.T){if _,err:=CanonicalizeJSON([]byte(v.InputJson));err==nil{t.Fatal("invalid input accepted")}})}
  for _,v:=range vectors.Routing{actual,err:=PolicyBucket(v.TenantId,v.ApplicationId,v.BusinessKey);if err!=nil||actual!=v.Bucket{t.Fatal("routing bucket mismatch")}}
}
