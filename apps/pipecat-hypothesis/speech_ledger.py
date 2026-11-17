"""Per-call output reservations shared by prepared and streamed speech.

Entries mean queued/released to TTS, not proof of telephone audibility. Explicit
listener-requested repair may repeat them; routine dialogue cannot.
"""
import re


def fingerprint(text):
    return ' '.join(re.sub(r'[\W_]+',' ',text.casefold().replace('ё','е')).split())


class SpeechLedger:
    def __init__(self,name):
        self.name=fingerprint(name);self.spoken_name=name;self.queued={};self.reserved={}

    def keys(self,sentence):
        value=fingerprint(sentence)
        if not value:return set()
        keys={'text:'+value}
        if re.search(r'(?:^|\s)(?:меня зовут|я)\s+'+re.escape(self.name)+r'(?:\s|$)',value) or value=='да '+self.name:
            keys.add('identity:customer_name')
        return keys

    def available(self,text):
        owner=object()
        result,_=self.reserve(text,owner)
        self.release(owner)
        return bool(result)

    @staticmethod
    def sentences(text):
        return [s.strip() for s in re.split(r'(?<=[.!?…])\s+',text.strip()) if s.strip()]

    def reserve(self,text,owner,repeat=False,repeat_keys=()):
        allowed=set(repeat_keys)
        kept=[];blocked=[]
        for sentence in self.sentences(text):
            keys=self.keys(sentence)
            if not keys:continue
            if not repeat and 'identity:customer_name' not in allowed and 'identity:customer_name' in keys and 'identity:customer_name' in (self.queued.keys()|self.reserved.keys()):
                original=sentence
                sentence=re.sub(r'\b(?:меня зовут|я)\s+'+re.escape(self.spoken_name)+r'\b\s*[,;:]?\s*','',sentence,count=1,flags=re.I).strip(' ,;:')
                blocked.append(original);keys=self.keys(sentence)
                if not keys:continue
            if not repeat and (keys-allowed)&(self.queued.keys()|self.reserved.keys()):
                blocked.append(sentence);continue
            kept.append(sentence)
            if not repeat:
                for key in keys-allowed:self.reserved[key]=owner
        return ' '.join(kept),blocked

    def commit(self,owner,response_id):
        for key in [k for k,v in self.reserved.items() if v==owner]:
            self.queued[key]=response_id;del self.reserved[key]

    def release(self,owner):
        for key in [k for k,v in self.reserved.items() if v==owner]:del self.reserved[key]
