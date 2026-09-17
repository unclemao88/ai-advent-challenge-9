# DeepSeek tokenizer

`tokenizer.json` and `tokenizer_config.json` from
[deepseek-ai/DeepSeek-V3.2-Exp](https://huggingface.co/deepseek-ai/DeepSeek-V3.2-Exp)
(byte-identical to DeepSeek-V3.1's), used for exact token counts.

They are not committed. Install them with:

```sh
npm run fetch:tokenizer
```

The script checks the SHA-256 of `tokenizer.json`. Without these files the app
still runs and shows estimated counts, labelled as such.
