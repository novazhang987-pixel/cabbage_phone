/* 一句话拆成食材字段 —— 从后端 app/parser.py 一比一搬过来的同一套规则。
 *
 * 只给浏览器里的语音/打字录入用：不联网、不调模型。
 * 「鸡蛋 10个 放冷藏 保质期25天」→ 名称 / 数量 / 单位 / 分类 / 位置 / 保质期
 *
 * 原则和 Python 版一样：宁可少解析，不要解析错；明确说出来的（matched）和
 * 按常识补的（inferred）分开返回，前端把猜的标蓝框让人确认。
 */

(function () {
  /* ---------------- 中文数字 ---------------- */

  const CN_DIGITS = {
    零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100,
  };

  function cnToNumber(text) {
    if (!text) return null;
    let total = 0;
    let number = 0;
    for (const char of text) {
      if (!(char in CN_DIGITS)) return null;
      const value = CN_DIGITS[char];
      if (value === 10 || value === 100) {
        number = number || 1;
        total += number * value;
        number = 0;
      } else {
        number = value;
      }
    }
    return total + number;
  }

  /* ---------------- 工具 ---------------- */

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const MASK = "\u0000";
  const PUNCT = " \t\u3000,，。.、;；:：!！?？\"'“”‘’()（）[]【】-—_/\\";

  function stripChars(text, chars) {
    let start = 0;
    let end = text.length;
    while (start < end && chars.includes(text[start])) start += 1;
    while (end > start && chars.includes(text[end - 1])) end -= 1;
    return text.slice(start, end);
  }

  const byLengthDesc = (keys) => [...keys].sort((a, b) => b.length - a.length);
  const alt = (keys) => byLengthDesc(keys).map(escapeRe).join("|");

  /* ---------------- 单位 ---------------- */

  const UNIT_ALIASES = {
    个: "个", 只: "个", 颗: "个", 枚: "个", pcs: "个", pc: "个", piece: "个", pieces: "个",
    斤: "斤", jin: "斤",
    克: "克", g: "克", gram: "克", grams: "克",
    千克: "千克", 公斤: "千克", kg: "千克", kgs: "千克",
    包: "包", pack: "包", packs: "包",
    袋: "袋", bag: "袋", bags: "袋",
    盒: "盒", box: "盒", boxes: "盒",
    瓶: "瓶", bottle: "瓶", bottles: "瓶",
    罐: "罐", can: "罐", cans: "罐",
    把: "把", bunch: "把", bunches: "把",
    块: "块",
    条: "条", strip: "条",
    根: "根", root: "根",
    升: "升", l: "升", liter: "升", litre: "升", liters: "升", litres: "升",
    毫升: "毫升", ml: "毫升",
  };

  const UNIT_ALT = alt(Object.keys(UNIT_ALIASES));

  // 阿拉伯数字可以不带单位；中文数字必须带单位，否则「三文鱼」会被当成 3 条鱼
  const QTY_RE = new RegExp(
    "(?<num>\\d+(?:\\.\\d+)?)\\s*(?<unit1>" + UNIT_ALT + ")?"
    + "|(?<num_cn>[一二两三四五六七八九十百]+)\\s*(?<unit2>" + UNIT_ALT + ")",
    "i"
  );

  /* ---------------- 保质期 ---------------- */

  const SHELF_UNIT_DAYS = {
    天: 1, 日: 1, day: 1, days: 1,
    周: 7, 星期: 7, 礼拜: 7, week: 7, weeks: 7,
    个月: 30, 月: 30, month: 30, months: 30,
    年: 365, year: 365, years: 365,
  };

  const SHELF_UNIT_ALT = alt(Object.keys(SHELF_UNIT_DAYS));
  const NUM = "(\\d+(?:\\.\\d+)?|[一二两三四五六七八九十百]+)";

  const SHELF_PATTERNS = [
    new RegExp("(?:保质期|保存期|保鲜期|存放期|可以放|能放|可放|存放|保存|保质)\\s*(?:为|是|有|大概|约)?\\s*" + NUM + "\\s*(" + SHELF_UNIT_ALT + ")"),
    new RegExp(NUM + "\\s*(" + SHELF_UNIT_ALT + ")\\s*(?:后过期|内吃完|内食用|内喝完|过期)"),
    new RegExp("(?:expires?|shelf\\s*life|good\\s*for|lasts?|keep\\s*for)\\s*(?:in|for|about)?\\s*(\\d+(?:\\.\\d+)?)\\s*(" + SHELF_UNIT_ALT + ")", "i"),
  ];

  /* ---------------- 存放位置 ---------------- */

  const LOCATION_ALIASES = {
    冷藏: "冷藏", 冰箱: "冷藏", 保鲜: "冷藏", fridge: "冷藏", refrigerator: "冷藏", refrigerated: "冷藏",
    冷冻: "冷冻", 冰柜: "冷冻", freezer: "冷冻", frozen: "冷冻",
    常温: "常温", 室温: "常温", "room temperature": "常温", "room temp": "常温", "pantry shelf": "常温",
    橱柜: "橱柜", 柜子: "橱柜", pantry: "橱柜", cabinet: "橱柜", cupboard: "橱柜",
    阳台: "阳台", balcony: "阳台",
  };

  const LOCATION_CUES_ZH = ["放", "存", "塞", "搁", "收", "冻", "在"];
  const LOCATION_CUES_EN = /(?:put|keep|store|place|in|into|to|at)\s+(?:the\s+)?$/i;
  const LOCATION_POSSESSIVE = ["里", "中", "内", "上", "面"];
  const LOCATION_LEADING = ["了", "着", "过", "进", "放", "上"];

  function findLocation(text) {
    let best = null;
    for (const alias of byLengthDesc(Object.keys(LOCATION_ALIASES))) {
      const re = new RegExp(escapeRe(alias), "gi");
      let match;
      while ((match = re.exec(text)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        const before = text.slice(Math.max(0, start - 4), start);
        const hasCue = LOCATION_CUES_ZH.some((cue) => before.includes(cue)) || LOCATION_CUES_EN.test(before);
        const possessive = LOCATION_POSSESSIVE.includes(text[end] || "");
        const atEnd = stripChars(text.slice(end), PUNCT + MASK) === "";
        const leading = start === 0 && LOCATION_LEADING.includes(text[end] || "");
        if (!(hasCue || possessive || atEnd || leading)) continue;
        const score = hasCue || possessive || leading ? 0 : 1;
        const candidate = [score, -end, alias, [start, end]];
        if (!best || candidate[0] < best[0] || (candidate[0] === best[0] && candidate[1] < best[1])) {
          best = candidate;
        }
      }
    }
    if (!best) return null;
    return [LOCATION_ALIASES[best[2].toLowerCase()], best[3]];
  }

  /* ---------------- 分类 ---------------- */

  const CATEGORY_ALIASES = {
    蔬菜: "蔬菜", 青菜: "蔬菜", vegetable: "蔬菜", vegetables: "蔬菜", veggie: "蔬菜", veggies: "蔬菜",
    水果: "水果", fruit: "水果", fruits: "水果",
    肉类: "肉类", 肉: "肉类", meat: "肉类",
    水产: "水产", 海鲜: "水产", seafood: "水产", fish: "水产",
    蛋奶: "蛋奶", 乳制品: "蛋奶", dairy: "蛋奶", egg: "蛋奶", eggs: "蛋奶",
    豆制品: "豆制品", soy: "豆制品", tofu: "豆制品",
    主食: "主食", staple: "主食", staples: "主食", grain: "主食", grains: "主食",
    调料: "调料", 调味: "调料", seasoning: "调料", sauce: "调料", condiment: "调料",
    冷冻食品: "冷冻食品", 速冻: "冷冻食品", "frozen food": "冷冻食品",
    零食: "零食", snack: "零食", snacks: "零食",
    饮料: "饮料", 饮品: "饮料", drink: "饮料", drinks: "饮料", beverage: "饮料",
  };

  function findCategory(text) {
    for (const alias of byLengthDesc(Object.keys(CATEGORY_ALIASES))) {
      const match = new RegExp(escapeRe(alias), "i").exec(text);
      if (match) return [CATEGORY_ALIASES[alias.toLowerCase()], [match.index, match.index + match[0].length]];
    }
    return null;
  }

  /* ---------------- 食材常识表 ---------------- */

  // 关键词 / 分类 / 默认位置 / 默认保质期天数 / 默认单位
  const FOOD_TABLE = [
    ["鸡蛋/蛋/egg/eggs", "蛋奶", "冷藏", 25, "个"],
    ["牛奶/鲜奶/milk", "蛋奶", "冷藏", 7, "盒"],
    ["酸奶/yogurt/yoghurt", "蛋奶", "冷藏", 21, "盒"],
    ["芝士/奶酪/cheese", "蛋奶", "冷藏", 30, "盒"],
    ["黄油/butter", "蛋奶", "冷藏", 60, "盒"],
    ["豆腐/tofu", "豆制品", "冷藏", 3, "盒"],
    ["豆浆/soy milk", "豆制品", "冷藏", 3, "袋"],
    ["猪肉/pork", "肉类", "冷冻", 180, "斤"],
    ["牛肉/beef", "肉类", "冷冻", 180, "斤"],
    ["羊肉/lamb/mutton", "肉类", "冷冻", 180, "斤"],
    ["鸡胸肉/鸡腿/鸡肉/chicken", "肉类", "冷冻", 180, "斤"],
    ["排骨/ribs", "肉类", "冷冻", 180, "斤"],
    ["火腿/ham", "肉类", "冷藏", 30, "包"],
    ["香肠/sausage", "肉类", "冷藏", 30, "包"],
    ["培根/bacon", "肉类", "冷藏", 30, "包"],
    ["三文鱼/三文/鲈鱼/salmon", "水产", "冷冻", 90, "条"],
    ["虾/shrimp/prawn/prawns", "水产", "冷冻", 180, "袋"],
    ["鱼/fish", "水产", "冷冻", 120, "条"],
    ["螃蟹/蟹/crab", "水产", "冷冻", 90, "斤"],
    ["里脊/loin", "肉类", "冷冻", 180, "斤"],
    ["西红柿/番茄/tomato/tomatoes", "蔬菜", "常温", 7, "个"],
    ["黄瓜/cucumber", "蔬菜", "冷藏", 7, "根"],
    ["胡萝卜/carrot/carrots", "蔬菜", "冷藏", 20, "根"],
    ["土豆/马铃薯/potato/potatoes", "蔬菜", "常温", 30, "个"],
    ["洋葱/onion/onions", "蔬菜", "常温", 30, "个"],
    ["菠菜/spinach", "蔬菜", "冷藏", 5, "把"],
    ["白菜/生菜/油菜/青菜/蔬菜/lettuce/cabbage", "蔬菜", "冷藏", 7, "把"],
    ["青椒/辣椒/pepper", "蔬菜", "冷藏", 10, "个"],
    ["蘑菇/香菇/mushroom/mushrooms", "蔬菜", "冷藏", 7, "盒"],
    ["苹果/apple/apples", "水果", "冷藏", 30, "个"],
    ["香蕉/banana/bananas", "水果", "常温", 7, "把"],
    ["橙子/橘子/桔子/orange/oranges", "水果", "常温", 14, "个"],
    ["葡萄/grape/grapes", "水果", "冷藏", 7, "斤"],
    ["西瓜/watermelon", "水果", "冷藏", 7, "个"],
    ["草莓/strawberry/strawberries", "水果", "冷藏", 3, "盒"],
    ["面包/bread", "主食", "常温", 5, "袋"],
    ["挂面/面条/面/noodle/noodles", "主食", "橱柜", 365, "袋"],
    ["大米/米/rice", "主食", "橱柜", 365, "袋"],
    ["面粉/flour", "主食", "橱柜", 180, "袋"],
    ["馒头/包子/bun/buns", "主食", "冷冻", 60, "袋"],
    ["食用油/油/oil", "调料", "橱柜", 540, "瓶"],
    ["生抽/老抽/酱油/soy sauce", "调料", "橱柜", 540, "瓶"],
    ["醋/vinegar", "调料", "橱柜", 540, "瓶"],
    ["盐/salt", "调料", "橱柜", 1095, "袋"],
    ["糖/sugar", "调料", "橱柜", 730, "袋"],
    ["蜂蜜/honey", "调料", "常温", 730, "瓶"],
    ["饺子/汤圆/dumpling/dumplings", "冷冻食品", "冷冻", 180, "袋"],
    ["冰淇淋/雪糕/ice cream", "冷冻食品", "冷冻", 365, "盒"],
    ["可乐/汽水/饮料/cola/soda/juice", "饮料", "常温", 270, "瓶"],
    ["啤酒/beer", "饮料", "冷藏", 180, "罐"],
    ["薯片/零食/chips/snack", "零食", "常温", 180, "袋"],
    ["巧克力/chocolate", "零食", "常温", 365, "块"],
  ];

  const FOOD_KNOWLEDGE = {};
  for (const [keywords, category, location, days, unit] of FOOD_TABLE) {
    for (const keyword of keywords.split("/")) {
      FOOD_KNOWLEDGE[keyword.trim().toLowerCase()] = [category, location, days, unit];
    }
  }
  const FOOD_KEYS = byLengthDesc(Object.keys(FOOD_KNOWLEDGE));

  /* ---------------- 填充词 ---------------- */

  const FILLER_ZH = [
    "我刚刚买了", "我刚买了", "我买了", "又买了", "新买了", "买回来", "买了",
    "新买的", "刚买的", "才买的", "昨天买的", "今天买的", "买的",
    "买", "添加", "新增", "录入", "记录一下", "记录",
    "放进", "放到", "放在", "放", "还有", "一些", "一点", "大概", "大约",
    "保质期", "保存期", "保鲜期", "存放期", "里面", "里边", "里头", "的", "了", "在", "里",
  ];

  const FILLER_EN = [
    /i\s+bought/gi, /i\s+just\s+bought/gi, /bought/gi, /buy/gi, /add(?:ed)?/gi, /put/gi, /into/gi, /in\s+the/gi,
    /\bin\b/gi, /\bthe\b/gi, /\ba\b/gi, /\ban\b/gi, /\bof\b/gi, /\bat\b/gi, /\bto\b/gi, /\bsome\b/gi,
    /\bnew\b/gi, /\bplease\b/gi, /\brecord\b/gi, /\bfor\b/gi, /\babout\b/gi,
  ];

  function knownFood(text) {
    const lowered = text.toLowerCase();
    for (const keyword of FOOD_KEYS) {
      if (lowered.includes(keyword)) return keyword;
    }
    return null;
  }

  function cleanName(text) {
    let cleaned = text;
    for (const filler of FILLER_ZH) cleaned = cleaned.split(filler).join(" ");
    for (const pattern of FILLER_EN) cleaned = cleaned.replace(pattern, " ");
    cleaned = stripChars(cleaned, PUNCT);
    cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
    return cleaned || null;
  }

  /* ---------------- 主函数 ---------------- */

  function parseText(rawText, lang) {
    const raw = (rawText || "").trim();
    const chars = [...raw];
    const matched = [];
    const inferred = [];
    const warnings = [];

    const current = () => chars.join("");
    const mask = (span) => {
      for (let i = span[0]; i < span[1]; i += 1) chars[i] = MASK;
    };

    const result = {
      name: null, category: null, quantity: null, unit: null, location: null, shelf_life_days: null,
    };

    // 1) 保质期先抠出来，免得里面的「25」被当成数量
    for (const pattern of SHELF_PATTERNS) {
      const match = pattern.exec(current());
      if (!match) continue;
      const numberText = match[1];
      const number = /^\d/.test(numberText) ? parseFloat(numberText) : cnToNumber(numberText);
      if (number === null) continue;
      const days = SHELF_UNIT_DAYS[match[2].toLowerCase()];
      if (!days) continue;
      result.shelf_life_days = Math.round(number * days);
      mask([match.index, match.index + match[0].length]);
      matched.push("shelf_life_days");
      break;
    }

    // 2) 数量 + 单位
    const qty = QTY_RE.exec(current());
    if (qty) {
      const numberText = qty.groups.num || qty.groups.num_cn || "";
      const unitText = (qty.groups.unit1 || qty.groups.unit2 || "").toLowerCase();
      const quantity = /^\d/.test(numberText) ? parseFloat(numberText) : cnToNumber(numberText);
      if (quantity !== null) {
        result.quantity = Math.round(quantity * 1000) / 1000;
        matched.push("quantity");
      }
      const canonical = UNIT_ALIASES[unitText];
      if (canonical) {
        result.unit = canonical;
        matched.push("unit");
      }
      mask([qty.index, qty.index + qty[0].length]);
    }

    // 3) 存放位置（带提示词、跟在「里/中」后面、句尾、或句首当动词用）
    const location = findLocation(current());
    if (location) {
      result.location = location[0];
      mask(location[1]);
      matched.push("location");
    }

    // 4) 分类
    const category = findCategory(current());
    if (category) {
      result.category = category[0];
      mask(category[1]);
      matched.push("category");
    }

    // 5) 剩下的就是名字
    result.name = cleanName(current().split(MASK).join(" "));

    // 兜底：名字没抠出来（或只剩一两个字），就用常识表里认出来的关键词
    const known = knownFood(raw);
    if (known && (!result.name || result.name.length < 2)) {
      result.name = known;
    } else if (known && result.name) {
      const index = result.name.toLowerCase().indexOf(known);
      const head = index > 0 ? result.name.slice(0, index) : "";
      if (index > 0 && index <= 2 && [...head].every((char) => "点些个把只块的大约一了两".includes(char))) {
        result.name = result.name.slice(index);
      }
    }

    // 6) 按食材常识补缺
    let keyword = known;
    if (result.name) {
      const lowered = result.name.toLowerCase();
      keyword = keyword || FOOD_KEYS.find((key) => lowered.includes(key)) || null;
    }
    if (keyword) {
      const [cat, loc, days, unit] = FOOD_KNOWLEDGE[keyword];
      const fill = { category: cat, location: loc, shelf_life_days: days, unit };
      for (const field of ["category", "location", "shelf_life_days", "unit"]) {
        if (result[field] === null || result[field] === undefined) {
          result[field] = fill[field];
          inferred.push(field);
        }
      }
    }

    if (!result.name) {
      warnings.push(lang === "en"
        ? "Couldn't catch the ingredient name — say it again or type it"
        : "没听清是什么食材，再说一次或者直接打字吧");
    }

    return Object.assign(result, { matched, inferred, warnings, raw });
  }

  window.LocalParser = { parseText, cnToNumber, FOOD_KNOWLEDGE };
})();
