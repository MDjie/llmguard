package guardllm

import (
  "bytes"
  "crypto/sha256"
  "encoding/binary"
  "encoding/hex"
  "encoding/json"
  "errors"
  "fmt"
  "io"
  "math"
  "sort"
  "strconv"
  "strings"
  "unicode/utf16"
  "unicode/utf8"
)

// CanonicalizeJSON uses guard-canonical-v2, not the legacy context signing format.
func CanonicalizeJSON(raw []byte) (string,error) {
  if !utf8.Valid(raw) { return "",errors.New("INVALID_UNICODE") }
  if err:=validateSurrogateEscapes(raw);err!=nil{return "",err}
  decoder:=json.NewDecoder(bytes.NewReader(raw));decoder.UseNumber()
  var value interface{}
  if err:=decoder.Decode(&value);err!=nil{return "",err}
  var extra interface{}
  if err:=decoder.Decode(&extra);err!=io.EOF{return "",errors.New("TRAILING_JSON")}
  return canonicalValue(value,0)
}
func validateSurrogateEscapes(raw []byte)error {
  inString:=false
  for i:=0;i<len(raw);i++{
    if raw[i]=='"' {inString=!inString;continue}
    if !inString||raw[i]!='\\'{continue}
    i++;if i>=len(raw){return errors.New("INVALID_JSON_ESCAPE")}
    if raw[i]!='u'{continue}
    if i+4>=len(raw){return errors.New("INVALID_JSON_ESCAPE")}
    n,err:=strconv.ParseUint(string(raw[i+1:i+5]),16,16);if err!=nil{return err};i+=4
    if n>=0xd800&&n<=0xdbff {
      if i+6>=len(raw)||raw[i+1]!='\\'||raw[i+2]!='u'{return errors.New("INVALID_UNICODE")}
      low,err:=strconv.ParseUint(string(raw[i+3:i+7]),16,16)
      if err!=nil||low<0xdc00||low>0xdfff{return errors.New("INVALID_UNICODE")};i+=6
    } else if n>=0xdc00&&n<=0xdfff{return errors.New("INVALID_UNICODE")}
  }
  return nil
}
func quoteCanonical(text string)(string,error){
  if !utf8.ValidString(text){return "",errors.New("INVALID_UNICODE")}
  var b strings.Builder;b.WriteByte('"')
  for _,r:=range text{
    switch r{
    case '"':b.WriteString("\\\"")
    case '\\':b.WriteString("\\\\")
    case '\b':b.WriteString("\\b")
    case '\f':b.WriteString("\\f")
    case '\n':b.WriteString("\\n")
    case '\r':b.WriteString("\\r")
    case '\t':b.WriteString("\\t")
    default:if r<0x20{fmt.Fprintf(&b,"\\u%04x",r)}else{b.WriteRune(r)}
    }
  }
  b.WriteByte('"');return b.String(),nil
}
func canonicalValue(value interface{},depth int)(string,error){
  if depth>64{return "",errors.New("JSON_DEPTH_EXCEEDED")}
  switch v:=value.(type){
  case nil:return "null",nil
  case bool:if v{return "true",nil};return "false",nil
  case string:return quoteCanonical(v)
  case json.Number:
    number,err:=strconv.ParseFloat(string(v),64)
    if err!=nil||math.IsInf(number,0)||math.IsNaN(number){return "",errors.New("NON_FINITE_NUMBER")}
    if number==0{return "0",nil}
    return strconv.FormatFloat(number,'f',-1,64),nil
  case []interface{}:
    parts:=make([]string,len(v));for i,item:=range v{encoded,err:=canonicalValue(item,depth+1);if err!=nil{return "",err};parts[i]=encoded}
    return "["+strings.Join(parts,",")+"]",nil
  case map[string]interface{}:
    keys:=make([]string,0,len(v));for key:=range v{keys=append(keys,key)}
    sort.Slice(keys,func(i,j int)bool{
      left,right:=utf16.Encode([]rune(keys[i])),utf16.Encode([]rune(keys[j]))
      for n:=0;n<len(left)&&n<len(right);n++{if left[n]!=right[n]{return left[n]<right[n]}}
      return len(left)<len(right)
    })
    parts:=make([]string,0,len(keys))
    for _,key:=range keys{k,err:=quoteCanonical(key);if err!=nil{return "",err};item,err:=canonicalValue(v[key],depth+1);if err!=nil{return "",err};parts=append(parts,k+":"+item)}
    return "{"+strings.Join(parts,",")+"}",nil
  default:return "",errors.New("INVALID_JSON_VALUE")
  }
}
func CanonicalSHA256(raw []byte)(string,error){value,err:=CanonicalizeJSON(raw);if err!=nil{return "",err};sum:=sha256.Sum256([]byte(value));return hex.EncodeToString(sum[:]),nil}
func PolicyBucket(tenantID,applicationID,businessKey string)(uint32,error){
  raw,err:=json.Marshal([]string{tenantID,applicationID,businessKey});if err!=nil{return 0,err}
  value,err:=CanonicalizeJSON(raw);if err!=nil{return 0,err};sum:=sha256.Sum256([]byte(value));return binary.BigEndian.Uint32(sum[:4])%100,nil
}
