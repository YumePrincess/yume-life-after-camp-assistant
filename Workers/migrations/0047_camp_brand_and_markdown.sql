-- Store camp group content in the existing camp settings and update only the
-- former built-in camp and site names. Custom administrator values survive.
UPDATE settings
SET value = json_set(
      json_remove(value, '$.campGroupDataUrl'),
      '$.campGroupMarkdown', COALESCE(
        json_extract(value, '$.campGroupMarkdown'),
        '# 明日之后“雨梦庭”营地交流群' || char(10) || char(10) ||
        '请扫描以下二维码加入营地群，' || char(10) || char(10) ||
        '进入营地群后请修改名片为你的游戏昵称，否则可能会因无法辨认而被定期移出群聊。' || char(10) || char(10) ||
        'QQ群：' || char(10) || char(10) ||
        '![QQ群二维码](/images/camp-groups/qq.png)' || char(10) || char(10) ||
        '微信群：' || char(10) || char(10) ||
        '![微信群二维码](/images/camp-groups/wx.png)' || char(10) || char(10) ||
        '如群二维码过期未更新，请联系管理。'
      ),
      '$.campName', CASE WHEN json_extract(value, '$.campName') = '愿' THEN '雨梦庭' ELSE json_extract(value, '$.campName') END,
      '$.publicSiteName', CASE WHEN json_extract(value, '$.publicSiteName') = '明日之后“愿”营地助手' THEN '明日之后“雨梦庭”营地助手' ELSE json_extract(value, '$.publicSiteName') END
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE key = 'camp_config';

UPDATE settings
SET value = json_set(value, '$.fromName', '明日之后“雨梦庭”营地助手'),
    updated_at = CURRENT_TIMESTAMP
WHERE key = 'smtp_config'
  AND json_extract(value, '$.fromName') = '明日之后“愿”营地助手';
