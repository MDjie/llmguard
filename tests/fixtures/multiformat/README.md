# 合成格式样本

这些文件由 Pillow、python-docx、openpyxl、python-pptx、LibreOffice 和 FFmpeg 等工具生成，仅含合成图像、纯音、色块及格式测试文字，不来自业务会话或 eval-data。

用于解码、上传和完整性回归，不能作为独立安全质量集。manifest.json 固定原始字节摘要及 PCM 参数。GIF/TIFF/PDF 各有两帧/页；XLSX 包含隐藏工作表，PPTX 包含备注。其它文档样本为单页渲染。

GB18030 文件需要显式指定编码；UTF-16 文件带 BOM。音频为约一秒纯音，视频为约一秒色块+纯音，不能证明语音/视觉安全检测质量。HEIC/AVIF 由合成图像编码得到。

追加 SRT/VTT/ASS/SSA 合成字幕；`.ts` 为 MPEG-TS 视频，整个素材目录应排除出 TypeScript/ESLint。原始样本禁止 Git 换行转换，以保持 manifest 哈希。
