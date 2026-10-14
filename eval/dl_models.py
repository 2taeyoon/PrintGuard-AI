from huggingface_hub import snapshot_download
for m in ["jhgan/ko-sroberta-multitask","intfloat/multilingual-e5-small","BAAI/bge-m3","nlpai-lab/KURE-v1"]:
    try:
        p=snapshot_download(m, allow_patterns=["*.json","*.txt","*.model","*.safetensors","*.py","modules.json","1_Pooling/*","sentencepiece*","tokenizer*"], ignore_patterns=["*onnx*","*.bin","*.h5","*.msgpack","pytorch_model*"])
        print("OK",m,p,flush=True)
    except Exception as e:
        print("FAIL",m,e,flush=True)
