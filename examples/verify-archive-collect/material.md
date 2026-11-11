验收对象：发布包 tgz（npm pack 产物）
S1 package/index.js 的内容哈希必须等于发布记录里的值。
S2 package/package.json 与 package/index.js 必须都在包里。
S3 包里不得出现清单之外的路径。
S4 同一路径不得出现两次。
S5 路径不得是绝对路径，不得含 .. 段、空段、反斜杠或控制字符，必须在 package/ 下。
S6 只允许普通文件和目录。
