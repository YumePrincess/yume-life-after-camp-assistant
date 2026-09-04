import type { TechnologyDefinition } from "./domain";
import { normalizeLocale, type SupportedLocale } from "./locale";

type Translation = Record<Exclude<SupportedLocale, "zh-cn">, string>;
type Entry = { name: Translation; description: Translation };

const L = (
  zhTwName: string,
  enName: string,
  frName: string,
  jaName: string,
  zhTwDescription: string,
  enDescription: string,
  frDescription: string,
  jaDescription: string
): Entry => ({
  name: { "zh-tw": zhTwName, en: enName, fr: frName, ja: jaName },
  description: {
    "zh-tw": zhTwDescription,
    en: enDescription,
    fr: frDescription,
    ja: jaDescription
  }
});

export const TECHNOLOGY_LOCALIZATIONS: Record<string, Entry> = {
  温室大棚: L("溫室大棚", "Greenhouse", "Serre", "温室", "作物不會受到天氣影響減產", "Crops do not lose yield because of weather.", "Les cultures ne perdent pas de rendement à cause de la météo.", "天候による作物の収穫量低下を防ぎます。"),
  大丰收: L("大豐收", "Bumper Harvest", "Récolte abondante", "大豊作", "收穫作物時獲得額外資源", "Harvesting crops grants extra resources.", "La récolte des cultures accorde des ressources supplémentaires.", "作物の収穫時に追加資源を獲得します。"),
  种豆得豆: L("種豆得豆", "Seeds from Crops", "Graines de récolte", "種から種へ", "種植作物有機率產出種子", "Planted crops have a chance to produce seeds.", "Les cultures plantées peuvent produire des graines.", "栽培した作物から種を入手できる場合があります。"),
  资源收购商: L("資源收購商", "Resource Buyer", "Acheteur de ressources", "資源買取商", "萊文市郊的傑克每天會用500金條收購綠色以上的物資。", "Jack in the outskirts of Levin City buys green-quality or better supplies for 500 gold bars every day.", "Dans la banlieue de Levin, Jack achète chaque jour les ressources de qualité verte ou supérieure pour 500 lingots d’or.", "レヴィン市郊外のジャックが毎日500金塊で緑色以上の物資を買い取ります。"),
  许可证扩容: L("許可證擴容", "Permit Expansion", "Extension du permis", "許可枠拡張", "每日提升開採許可證的資源額度", "Increases the daily resource allowance of mining permits.", "Augmente le quota quotidien de ressources du permis d’extraction.", "採集許可証の1日資源上限を増やします。"),
  重返鱼塘: L("重返魚塘", "Return to the Fishpond", "Retour à l’étang", "釣り池へ帰ろう", "營地魚塘的魚種增加", "Adds more fish species to the camp fishpond.", "Ajoute davantage d’espèces à l’étang du camp.", "野営地の釣り池に魚種が増えます。"),
  "加速印刷（墙纸印刷师）": L("加速印刷（壁紙印刷師）", "Faster Printing (Wallpaper Printer)", "Impression rapide (Imprimeur)", "高速印刷（壁紙職人）", "阿姆斯壯的生產速度加快", "Armstrong produces wallpaper faster.", "Armstrong produit les papiers peints plus rapidement.", "アームストロングの生産速度が上がります。"),
  "印刷新品（墙纸印刷师）": L("印刷新品（壁紙印刷師）", "New Prints (Wallpaper Printer)", "Nouveaux motifs (Imprimeur)", "新作印刷（壁紙職人）", "阿姆斯壯會生產更好的壁紙", "Armstrong produces better wallpaper.", "Armstrong produit de meilleurs papiers peints.", "アームストロングがより良い壁紙を生産します。"),
  墙纸印刷师: L("壁紙印刷師", "Wallpaper Printer", "Imprimeur de papier peint", "壁紙職人", "阿姆斯壯為營地生產各種壁紙", "Armstrong produces various wallpapers for the camp.", "Armstrong produit divers papiers peints pour le camp.", "アームストロングが野営地向けの壁紙を生産します。"),
  "爆炸钩（捕鱼专家）": L("爆炸鉤（捕魚專家）", "Explosive Hook (Fishing Expert)", "Hameçon explosif (Expert pêche)", "爆発フック（釣り名人）", "慕容兄弟釣魚的速度加快", "The Murong brothers catch all fish faster.", "Les frères Murong pêchent tous les poissons plus vite.", "慕容兄弟の釣り速度が上がります。"),
  "新口味鱼饵（捕鱼专家）": L("新口味魚餌（捕魚專家）", "New Bait (Fishing Expert)", "Nouvel appât (Expert pêche)", "新味の餌（釣り名人）", "慕容兄弟會釣到更好的觀賞魚", "The Murong brothers catch better ornamental fish.", "Les frères Murong pêchent de meilleurs poissons d’ornement.", "慕容兄弟がより良い観賞魚を釣ります。"),
  捕鱼专家: L("捕魚專家", "Fishing Expert", "Expert en pêche", "釣り名人", "慕容兄弟可為營地和個人釣魚", "The Murong brothers fish for the camp and individuals.", "Les frères Murong pêchent pour le camp et ses membres.", "慕容兄弟が野営地と個人のために釣りをします。"),
  繁荣共振: L("繁榮共振", "Prosperity Resonance", "Résonance prospère", "繁栄共鳴", "互相澆水最多可獲得100點繁榮度", "Watering one another’s crops grants up to 100 Prosperity.", "Arroser les cultures des autres accorde jusqu’à 100 de prospérité.", "互いに水やりすると繁栄度を最大100獲得します。"),
  重振农业: L("重振農業", "Revitalize Agriculture", "Relance agricole", "農業復興", "採摘作物最多可獲得3點管理值", "Harvesting crops grants up to 3 Management points.", "Récolter des cultures accorde jusqu’à 3 points de gestion.", "作物の採取で管理値を最大3獲得します。"),
  勤奋的牧民: L("勤奮的牧民", "Diligent Herder", "Éleveur assidu", "勤勉な牧畜家", "畜牧業不會因天氣而減產", "Livestock production is not reduced by weather.", "L’élevage ne perd pas de rendement à cause de la météo.", "天候による畜産の生産量低下を防ぎます。"),
  坚韧的矿工: L("堅韌的礦工", "Resilient Miner", "Mineur résistant", "不屈の鉱夫", "採礦機器不會因天氣而減產", "Mining machines are not slowed by weather.", "Les machines minières ne perdent pas de rendement à cause de la météo.", "天候による採掘機の生産量低下を防ぎます。"),
  耐劳的农夫: L("耐勞的農夫", "Hardworking Farmer", "Fermier endurant", "働き者の農夫", "種植作物不會因天氣而減產", "Planted crops are not reduced by weather.", "Les cultures plantées ne perdent pas de rendement à cause de la météo.", "天候による栽培作物の収穫量低下を防ぎます。"),
  特强吸力: L("特強吸力", "Super Absorption", "Super absorption", "超吸収力", "被澆水或降溫時產出速度增加50%", "Output speed rises by 50% when watered or cooled by others.", "La production augmente de 50 % après arrosage ou refroidissement par autrui.", "他人の水やり・冷却時に生産速度が50%上がります。"),
  生物多样性: L("生物多樣性", "Biodiversity", "Biodiversité", "生物多様性", "採摘時農田每多一種作物產量增加5%", "Each additional crop type raises harvest yield by 5%.", "Chaque type de culture supplémentaire augmente le rendement de 5 %.", "農地の作物種類ごとに採取量が5%増えます。"),
  永葆青春: L("永葆青春", "Forever Young", "Jeunesse éternelle", "永遠の若さ", "農田作物在衰老期不會降低產量", "Crops do not lose yield during their aging stage.", "Les cultures ne perdent pas de rendement pendant leur vieillissement.", "老化期でも作物の収穫量が低下しません。"),
  采购优惠: L("採購優惠", "Purchase Discount", "Réduction d’achat", "購入割引", "在採集隊兌換物資時消耗的採集券減免20%，每日最高減免額度為4000採集券。", "Reduces gathering coupons spent when exchanging supplies with the gathering team by 20%, with a daily maximum discount of 4,000 gathering coupons.", "Réduit de 20 % les coupons de collecte utilisés pour échanger des fournitures auprès de l’équipe de collecte, avec une remise quotidienne maximale de 4 000 coupons.", "採集隊で物資を交換する際に消費する採集券を20%減らし、1日の割引上限は採集券4,000枚です。"),
  科学建造: L("科學建造", "Scientific Construction", "Construction scientifique", "科学建築", "基建時降低奈米素材消耗", "Reduces nanomaterial cost during infrastructure construction.", "Réduit le coût en nanomatériaux des infrastructures.", "インフラ建設時のナノ素材消費を減らします。"),
  电视推销员: L("電視推銷員", "TV Salesperson", "Télévendeur", "テレビ販売員", "電視遠程出售物品的保管費降低", "Reduces storage fees when selling items remotely by TV.", "Réduit les frais de garde des ventes à distance par télévision.", "テレビ遠隔販売時の保管料を減らします。"),
  刻苦专研: L("刻苦專研", "Dedicated Research", "Recherche assidue", "熱心な研究", "配方專研的新幣消耗降低", "Reduces New Dollar cost for formula research.", "Réduit le coût en nouveaux dollars de la recherche de formules.", "専門研究に必要な新貨幣を減らします。"),
  金砖戏法: L("金磚戲法", "Golden Brick Trick", "Tour de brique", "金レンガの手品", "搬運磚塊時變得更輕", "Makes bricks lighter while carrying them.", "Allège les briques pendant leur transport.", "運搬中のレンガが軽くなります。"),
  "加快制作（护甲店制作）": L("加快製作（護甲店製作）", "Faster Crafting (Armor Shop)", "Fabrication rapide (Armurerie)", "高速製作（防具店）", "莉莎的製作速度加快", "Lisa crafts faster.", "Lisa fabrique plus rapidement.", "リサの製作速度が上がります。"),
  护甲店制作: L("護甲店製作", "Armor Shop Crafting", "Fabrication d’armures", "防具店製作", "莉莎為營地和個人提供特殊材料", "Lisa provides special materials to the camp and individuals.", "Lisa fournit des matériaux spéciaux au camp et aux membres.", "リサが野営地と個人に特殊素材を提供します。"),
  "急速制作（武器店制作）": L("急速製作（武器店製作）", "Rapid Crafting (Weapon Shop)", "Fabrication express (Armes)", "急速製作（武器店）", "朱莉王的製作速度加快", "Julie Wang crafts faster.", "Julie Wang fabrique plus rapidement.", "ジュリー・ワンの製作速度が上がります。"),
  武器店制作: L("武器店製作", "Weapon Shop Crafting", "Fabrication d’armes", "武器店製作", "朱莉王為營地和個人提供特殊材料", "Julie Wang provides special materials to the camp and individuals.", "Julie Wang fournit des matériaux spéciaux au camp et aux membres.", "ジュリー・ワンが野営地と個人に特殊素材を提供します。"),
  高级饭堂: L("高級飯堂", "Advanced Canteen", "Cantine avancée", "高級食堂", "營地飯堂供應更強力的美食", "The camp canteen serves more powerful meals.", "La cantine du camp sert des plats plus puissants.", "野営地食堂でより強力な料理を提供します。"),
  美食的魅力: L("美食的魅力", "The Charm of Food", "Charme culinaire", "料理の魅力", "在飯堂捐獻最多獲得300點科技點", "Canteen donations grant up to 300 Technology points.", "Les dons à la cantine accordent jusqu’à 300 points technologiques.", "食堂への寄付で技術ポイントを最大300獲得します。"),
  雪中制甲: L("雪中製甲", "Armor in Snow", "Armure sous la neige", "雪中防具製作", "小雪或大雪時護甲店配件耗時減半", "Light or heavy snow halves armor-part production time.", "La neige légère ou forte réduit de moitié le temps des pièces d’armure.", "小雪・大雪時に防具部品の製作時間が半減します。"),
  热浪起武: L("熱浪起武", "Weapons in a Heatwave", "Armes sous la chaleur", "熱波武器製作", "熱浪天氣下武器店配件耗時減半", "Heatwaves halve weapon-part production time.", "Les vagues de chaleur réduisent de moitié le temps des pièces d’armes.", "熱波時に武器部品の製作時間が半減します。"),
  护甲订单: L("護甲訂單", "Armor Orders", "Commandes d’armure", "防具注文", "護甲店配件耗時縮減為90%", "Reduces armor-part production time to 90%.", "Réduit le temps de fabrication des pièces d’armure à 90 %.", "防具部品の製作時間を90%に短縮します。"),
  管理至上: L("管理至上", "Management First", "Gestion avant tout", "管理第一", "中心廣場機器生產時產生管理值", "Machines in Central Square generate Management points.", "Les machines de la place centrale génèrent des points de gestion.", "中央広場の機械生産で管理値を獲得します。"),
  加强出口: L("加強出口", "Boost Exports", "Booster les exportations", "輸出強化", "在交易之城售出護甲或武器可獲得科技點", "Selling armor or weapons in Trade City grants Technology points.", "Vendre des armures ou armes à la Cité du commerce accorde des points technologiques.", "交易都市で防具・武器を売ると技術ポイントを獲得します。"),
  武装订单: L("武裝訂單", "Weapon Orders", "Commandes d’armes", "武器注文", "武器店配件耗時縮減為90%", "Reduces weapon-part production time to 90%.", "Réduit le temps de fabrication des pièces d’armes à 90 %.", "武器部品の製作時間を90%に短縮します。"),
  远星暴走族: L("遠星暴走族", "Farstar Riders", "Pilotes de Farstar", "遠星ライダー", "在遠星城乘載具時對玩家傷害增加", "Increases damage to players while riding vehicles in Farstar City.", "Augmente les dégâts aux joueurs en véhicule à Farstar.", "遠星城で乗り物搭乗中の対人ダメージが上がります。"),
  护甲保险: L("護甲保險", "Armor Insurance", "Assurance d’armure", "防具保険", "入侵及特殊感染體圍剿中降低防具耐久消耗", "Reduces armor durability loss during invasions and special-infected hunts.", "Réduit l’usure des armures lors des invasions et chasses spéciales.", "感染者侵入・特殊感染体討伐で防具耐久消費を減らします。"),
  家园守卫: L("家園守衛", "Homeland Guard", "Garde du foyer", "故郷の守護", "在營地內對其他營地玩家造成更多傷害", "Increases damage to players from other camps while inside your camp.", "Augmente les dégâts contre les joueurs d’autres camps dans votre camp.", "野営地内で他の野営地プレイヤーへのダメージが上がります。"),
  移动守卫: L("移動守衛", "Mobile Guards", "Gardes mobiles", "移動衛兵", "營地會迎來巡邏守衛", "Patrolling guards arrive in the camp.", "Des gardes en patrouille arrivent dans le camp.", "野営地に巡回衛兵が現れます。"),
  擂台之星: L("擂台之星", "Arena Star", "Étoile de l’arène", "闘技場の星", "貞德給予營地擂台祝福", "Jeanne grants a blessing for the camp arena.", "Jeanne accorde une bénédiction pour l’arène du camp.", "ジャンヌが野営地闘技場の祝福を与えます。"),
  致远星城: L("致遠星城", "To Farstar City", "Vers Farstar", "遠星城へ", "貞德給予遠星城祝福", "Jeanne grants a blessing for Farstar City.", "Jeanne accorde une bénédiction pour Farstar.", "ジャンヌが遠星城の祝福を与えます。"),
  强袭夏尔镇: L("強襲夏爾鎮", "Assault Charles Town", "Assaut de Charles Town", "シャルルタウン強襲", "貞德給予夏爾鎮祝福", "Jeanne grants a blessing for Charles Town.", "Jeanne accorde une bénédiction pour Charles Town.", "ジャンヌがシャルルタウンの祝福を与えます。"),
  游走动荡之城: L("遊走動盪之城", "Roam Turbulent City", "Errance en ville agitée", "動乱の街を巡る", "貞德給予動盪之城祝福", "Jeanne grants a blessing for Turbulent City.", "Jeanne accorde une bénédiction pour la Ville agitée.", "ジャンヌが動乱の街の祝福を与えます。"),
  "快速装填（赤色瓶子）": L("快速裝填（赤色瓶子）", "Quick Fill (Red Bottle)", "Remplissage rapide (Fiole rouge)", "高速充填（赤い瓶）", "阿傑爾的製作速度加快", "Ajer works faster.", "Ajer travaille plus rapidement.", "アジェールの作業速度が上がります。"),
  "红绿瓶子（赤色瓶子）": L("紅綠瓶子（赤色瓶子）", "Red and Green Bottles (Red Bottle)", "Fioles rouge et verte", "赤と緑の瓶（赤い瓶）", "阿傑爾不時提供綠瓶泰坦素", "Ajer occasionally provides green-bottle Titan serum.", "Ajer fournit parfois du sérum Titan en fiole verte.", "アジェールが時々緑瓶タイタン素を提供します。"),
  赤色瓶子: L("赤色瓶子", "Red Bottle", "Fiole rouge", "赤い瓶", "阿傑爾為營地和個人提供紅瓶泰坦素", "Ajer provides red-bottle Titan serum to the camp and individuals.", "Ajer fournit du sérum Titan rouge au camp et aux membres.", "アジェールが野営地と個人に赤瓶タイタン素を提供します。"),
  弱化感染者: L("弱化感染者", "Weaken Infected", "Affaiblir les infectés", "感染者弱体化", "弱化感染者入侵活動中的感染者", "Weakens infected enemies during the Infected Invasion.", "Affaiblit les infectés pendant l’invasion.", "感染者侵入イベントの感染者を弱体化します。"),
  危险巡逻员: L("危險巡邏員", "Danger Patrol", "Patrouille dangereuse", "危険パトロール", "巡邏任務最多帶來500點繁榮度", "Patrol missions grant up to 500 Prosperity.", "Les patrouilles accordent jusqu’à 500 de prospérité.", "パトロール任務で繁栄度を最大500獲得します。"),
  阻挡入侵: L("阻擋入侵", "Repel Intruders", "Repousser l’invasion", "侵入阻止", "在營地內送外部玩家回家可獲得管理值", "Sending outside players home from the camp grants Management points.", "Renvoyer les joueurs extérieurs du camp accorde des points de gestion.", "野営地内で外部プレイヤーを送り返すと管理値を獲得します。"),
  不死士兵: L("不死士兵", "Undying Soldiers", "Soldats immortels", "不死の兵士", "衛兵被擊倒後更快甦醒", "Guards recover faster after being knocked down.", "Les gardes récupèrent plus vite après avoir été renversés.", "衛兵が倒された後の復帰が速くなります。"),
  安全与繁荣: L("安全與繁榮", "Safety and Prosperity", "Sécurité et prospérité", "安全と繁栄", "安全防衛戰成功可獲得繁榮度", "Successfully defending in Security Defense grants Prosperity.", "Réussir la défense de sécurité accorde de la prospérité.", "安全防衛戦の防衛成功で繁栄度を獲得します。"),
  大哥的视觉: L("大哥的視覺", "Big Brother’s Vision", "Vision du grand frère", "兄貴の視界", "非本地居民座標會間歇顯示在地圖上", "Coordinates of non-residents periodically appear on the map.", "Les coordonnées des non-résidents apparaissent périodiquement sur la carte.", "非居住者の座標が定期的に地図へ表示されます。"),
  恐怖宠物: L("恐怖寵物", "Fearsome Pets", "Animaux terrifiants", "恐怖のペット", "寵物昏迷後恢復速度提升至200%", "Pet recovery speed after incapacitation increases to 200%.", "La récupération des familiers après K.-O. passe à 200 %.", "ペットが気絶した後の回復速度が200%になります。")
};

export function localizeTechnology<T extends TechnologyDefinition>(
  technology: T,
  localeValue: unknown
): T {
  const locale = normalizeLocale(localeValue);
  if (locale === "zh-cn") return technology;
  const entry = TECHNOLOGY_LOCALIZATIONS[technology.name];
  if (!entry) return technology;
  return {
    ...technology,
    name: entry.name[locale],
    description: entry.description[locale],
    prerequisiteName: technology.prerequisiteName
      ? TECHNOLOGY_LOCALIZATIONS[technology.prerequisiteName]?.name[locale] ??
        technology.prerequisiteName
      : undefined
  };
}
