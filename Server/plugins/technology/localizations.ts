import type { TechnologyDefinition } from "../../src/domain";
import { normalizeLocale, type SupportedLocale } from "../../src/locale";

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
  温室大棚: L("溫室大棚", "Greenhouse", "Serre", "温室", "莊園種植作物、採礦機與養殖動物不會因惡劣天氣而減產。", "Crops, mining machines, and livestock in the manor do not lose yield due to bad weather.", "Les cultures, les machines minières et l’élevage du manoir ne subissent pas de baisse de rendement par mauvais temps.", "荘園の作物、採掘機、飼育動物は悪天候の影響で生産量が減少しません。"),
  大丰收: L("大豐收", "Bumper Harvest", "Récolte abondante", "大豊作", "在莊園內採集樹木與礦石時，有4%機率獲得雙倍資源；採收麻類與養殖動物時，額外產出8%。", "Gathering trees or ore in the manor has a 4% chance to yield double resources; harvesting hemp or collecting from livestock grants 8% extra output.", "Dans le manoir, récolter du bois ou du minerai a 4 % de chances de doubler les ressources ; récolter du chanvre ou récupérer les produits des animaux d’élevage procure 8 % de production supplémentaire.", "荘園で木材・鉱石を採集すると4%の確率で資源が2倍になり、麻類や飼育動物の収穫時には生産量が8%増加します。"),
  种豆得豆: L("種豆得豆", "Seeds from Crops", "Graines de récolte", "種から種へ", "在莊園收穫作物時，有5%機率獲得該作物的種子。", "Harvesting a crop in the manor has a 5% chance to yield its seed.", "Lors de la récolte d’une culture dans le manoir, vous avez 5 % de chances d’obtenir sa graine.", "荘園で作物を収穫すると、5%の確率でその作物の種を獲得します。"),
  资源收购商: L("資源收購商", "Resource Buyer", "Acheteur de ressources", "資源買取商", "萊文市郊的傑克每天會用500金條收購綠色以上的物資。", "Jack in the outskirts of Levin City buys green-quality or better supplies for 500 gold bars every day.", "Dans la banlieue de Levin, Jack achète chaque jour les ressources de qualité verte ou supérieure pour 500 lingots d’or.", "レヴィン市郊外のジャックが毎日500金塊で緑色以上の物資を買い取ります。"),
  许可证扩容: L("許可證擴容", "Permit Expansion", "Extension du permis", "許可枠拡張", "採集許可證每日貴重資源與珍稀資源的額度各增加5。", "Increases the daily permit quotas for valuable and rare resources by 5 each.", "Augmente de 5 chacun des quotas quotidiens du permis de collecte pour les ressources précieuses et rares.", "採集許可証で、貴重資源と希少資源の日次採集枠がそれぞれ5増加します。"),
  重返鱼塘: L("重返魚塘", "Return to the Fishpond", "Retour à l’étang", "釣り池へ帰ろう", "營地魚塘中可以釣到更好的魚。", "Better fish can be caught in the camp fishpond.", "De meilleurs poissons peuvent être pêchés dans l’étang du camp.", "野営地の釣り池で、より良い魚が釣れるようになります。"),
  "加速印刷（墙纸印刷师）": L("加速印刷（壁紙印刷師）", "Faster Printing (Wallpaper Printer)", "Impression rapide (Imprimeur)", "高速印刷（壁紙職人）", "阿姆斯壯的生產速度加快", "Armstrong produces wallpaper faster.", "Armstrong produit les papiers peints plus rapidement.", "アームストロングの生産速度が上がります。"),
  "印刷新品（墙纸印刷师）": L("印刷新品（壁紙印刷師）", "New Prints (Wallpaper Printer)", "Nouveaux motifs (Imprimeur)", "新作印刷（壁紙職人）", "阿姆斯壯會生產更好的壁紙", "Armstrong produces better wallpaper.", "Armstrong produit de meilleurs papiers peints.", "アームストロングがより良い壁紙を生産します。"),
  墙纸印刷师: L("壁紙印刷師", "Wallpaper Printer", "Imprimeur de papier peint", "壁紙職人", "阿姆斯壯為營地生產各種壁紙", "Armstrong produces various wallpapers for the camp.", "Armstrong produit divers papiers peints pour le camp.", "アームストロングが野営地向けの壁紙を生産します。"),
  "爆炸钩（捕鱼专家）": L("爆炸鉤（捕魚專家）", "Explosive Hook (Fishing Expert)", "Hameçon explosif (Expert pêche)", "爆発フック（釣り名人）", "慕容兄弟釣魚的速度加快", "The Murong brothers catch all fish faster.", "Les frères Murong pêchent tous les poissons plus vite.", "慕容兄弟の釣り速度が上がります。"),
  "新口味鱼饵（捕鱼专家）": L("新口味魚餌（捕魚專家）", "New Bait (Fishing Expert)", "Nouvel appât (Expert pêche)", "新味の餌（釣り名人）", "慕容兄弟會釣到更好的觀賞魚", "The Murong brothers catch better ornamental fish.", "Les frères Murong pêchent de meilleurs poissons d’ornement.", "慕容兄弟がより良い観賞魚を釣ります。"),
  捕鱼专家: L("捕魚專家", "Fishing Expert", "Expert en pêche", "釣り名人", "慕容兄弟可為營地和個人釣魚", "The Murong brothers fish for the camp and individuals.", "Les frères Murong pêchent pour le camp et ses membres.", "慕容兄弟が野営地と個人のために釣りをします。"),
  繁荣共振: L("繁榮共振", "Prosperity Resonance", "Résonance prospère", "繁栄共鳴", "在營地內互相澆花時可獲得1點繁榮度，每天最多100點。", "Watering one another’s flowers in the camp grants 1 Prosperity, up to 100 per day.", "Arroser les fleurs des autres dans le camp rapporte 1 point de prospérité, jusqu’à 100 par jour.", "野営地で互いに花へ水をやると繁栄度を1獲得し、1日最大100まで獲得できます。"),
  重振农业: L("重振農業", "Revitalize Agriculture", "Relance agricole", "農業復興", "營地每天每收穫10,000株作物，管理值增加1點，最多增加3點。", "For every 10,000 crops harvested in a day, the camp gains 1 Management point, up to 3.", "Pour chaque tranche de 10 000 cultures récoltées par jour, le camp gagne 1 point de gestion, jusqu’à 3.", "1日に作物を10,000個収穫するごとに、野営地の管理値が1増加し、最大3まで獲得できます。"),
  勤奋的牧民: L("勤奮的牧民", "Diligent Herder", "Éleveur assidu", "勤勉な牧畜家", "天氣轉壞時，不會影響莊園內的畜牧業。", "When the weather turns bad, livestock farming in the manor is unaffected.", "Lorsque le temps se dégrade, l’élevage du manoir n’est pas affecté.", "天候が悪化しても、荘園内の畜産には影響しません。"),
  坚韧的矿工: L("堅韌的礦工", "Resilient Miner", "Mineur résistant", "不屈の鉱夫", "天氣轉壞時，不會影響莊園內的採礦機器。", "When the weather turns bad, mining machines in the manor are unaffected.", "Lorsque le temps se dégrade, les machines minières du manoir ne sont pas affectées.", "天候が悪化しても、荘園内の採掘機には影響しません。"),
  耐劳的农夫: L("耐勞的農夫", "Hardworking Farmer", "Fermier endurant", "働き者の農夫", "天氣轉壞時，不會影響莊園內的作物種植。", "When the weather turns bad, crops planted in the manor are unaffected.", "Lorsque le temps se dégrade, les cultures du manoir ne sont pas affectées.", "天候が悪化しても、荘園内の作物には影響しません。"),
  特强吸力: L("特強吸力", "Super Absorption", "Super absorption", "超吸収力", "個人農田被非擁有者澆水或降溫時，作物的生長或產出速度增加50%。", "When someone other than the owner waters or cools a personal farm, crop growth or production speed increases by 50%.", "Lorsqu’une personne autre que le propriétaire arrose ou refroidit une ferme personnelle, la croissance ou la vitesse de production des cultures augmente de 50 %.", "個人農地で所有者以外の人が水やりまたは冷却を行うと、作物の成長速度または生産速度が50%上昇します。"),
  生物多样性: L("生物多樣性", "Biodiversity", "Biodiversité", "生物多様性", "個人農田中，首次採摘時每多一種作物，產量增加5%，最多增加25%。", "On a personal farm, each additional crop type present at the first harvest increases yield by 5%, up to 25%.", "Sur une ferme personnelle, chaque type de culture supplémentaire présent lors de la première récolte augmente le rendement de 5 %, jusqu’à 25 %.", "個人農地では、初回の収穫時に作物の種類が1種類増えるごとに収穫量が5%増加し、最大25%まで増加します。"),
  永葆青春: L("永葆青春", "Forever Young", "Jeunesse éternelle", "永遠の若さ", "個人農田的作物在衰老期不會減產。", "Crops on a personal farm do not lose yield during their aging stage.", "Les cultures des fermes personnelles ne subissent aucune baisse de rendement pendant leur phase de vieillissement.", "個人農地の作物は、老化期でも収穫量が減少しません。"),
  采购优惠: L("採購優惠", "Purchase Discount", "Réduction d’achat", "購入割引", "在採集隊兌換物資時消耗的採集券減免20%，每日最高減免額度為4000採集券。", "Reduces gathering coupons spent when exchanging supplies with the gathering team by 20%, with a daily maximum discount of 4,000 gathering coupons.", "Réduit de 20 % les coupons de collecte utilisés pour échanger des fournitures auprès de l’équipe de collecte, avec une remise quotidienne maximale de 4 000 coupons.", "採集隊で物資を交換する際に消費する採集券を20%減らし、1日の割引上限は採集券4,000枚です。"),
  电视购会员: L("電視購會員", "TV Shopping Membership", "Abonnement d’achat télévisé", "テレビ通販会員", "透過電視購買資源分類的物品時，運費降低為價格的1%。", "When purchasing resource-category items through TV, shipping fees are reduced to 1% of the price.", "Lors de l’achat par télévision d’objets de la catégorie des ressources, les frais d’expédition sont réduits à 1 % du prix.", "テレビで資源カテゴリのアイテムを購入すると、送料が価格の1%になります。"),
  科学建造: L("科學建造", "Scientific Construction", "Construction scientifique", "科学建築", "基建時奈米塑材消耗量減少10%（高速公路基建不生效）", "Reduces Nanoplastic consumption by 10% during infrastructure construction; does not apply to highway construction.", "Réduit de 10 % la consommation de nanoplastique lors de la construction d’infrastructures (ne s’applique pas aux autoroutes).", "インフラ建設時のナノプラスチック消費量が10%減少します（高速道路の建設には適用されません）。"),
  电视推销员: L("電視推銷員", "TV Salesperson", "Télévendeur", "テレビ販売員", "在電視上進行交易時額外徵收的3%保管費將會減免。", "Waives the additional 3% storage fee charged for trades made on the TV.", "Exonère des 3 % de frais de garde supplémentaires facturés lors des échanges à la télévision.", "テレビで取引する際に追加で徴収される3%の保管料が免除されます。"),
  刻苦专研: L("刻苦專研", "Dedicated Research", "Recherche assidue", "熱心な研究", "配方專研過程中，新幣消耗量減少10%", "During formula research, New Dollar consumption is reduced by 10%.", "Pendant la recherche de formules, la consommation de nouveaux dollars est réduite de 10 %.", "製法研究中、新貨幣の消費量が10%減少します。"),
  金砖戏法: L("金磚戲法", "Golden Brick Trick", "Tour de brique", "金レンガの手品", "在快樂101搬運材料時，有25%機率從少量／中量磚堆中找到大量磚頭。", "When carrying materials in Happy 101, there is a 25% chance of finding a large pile of bricks among small or medium piles.", "Lors du transport de matériaux à Happy 101, vous avez 25 % de chances de trouver un gros tas de briques parmi les tas petits ou moyens.", "ハッピー101で資材を運搬する際、少量または中量のレンガの山から、大量のレンガの山を25%の確率で見つけます。"),
  "加快制作（护甲店制作）": L("加快製作（護甲店製作）", "Faster Crafting (Armor Shop)", "Fabrication rapide (Armurerie)", "高速製作（防具店）", "莉莎的製作速度加快", "Lisa crafts faster.", "Lisa fabrique plus rapidement.", "リサの製作速度が上がります。"),
  护甲店制作: L("護甲店製作", "Armor Shop Crafting", "Fabrication d’armures", "防具店製作", "莉莎為營地和個人提供特殊材料", "Lisa provides special materials to the camp and individuals.", "Lisa fournit des matériaux spéciaux au camp et aux membres.", "リサが野営地と個人に特殊素材を提供します。"),
  "急速制作（武器店制作）": L("急速製作（武器店製作）", "Rapid Crafting (Weapon Shop)", "Fabrication express (Armes)", "急速製作（武器店）", "朱莉王的製作速度加快", "Julie Wang crafts faster.", "Julie Wang fabrique plus rapidement.", "ジュリー・ワンの製作速度が上がります。"),
  武器店制作: L("武器店製作", "Weapon Shop Crafting", "Fabrication d’armes", "武器店製作", "朱莉王為營地和個人提供特殊材料", "Julie Wang provides special materials to the camp and individuals.", "Julie Wang fournit des matériaux spéciaux au camp et aux membres.", "ジュリー・ワンが野営地と個人に特殊素材を提供します。"),
  高级饭堂: L("高級飯堂", "Advanced Canteen", "Cantine avancée", "高級食堂", "營地飯堂會供應更強力的美食。", "The camp canteen will serve more powerful meals.", "La cantine du camp servira des plats plus puissants.", "野営地の食堂で、より強力な料理が提供されます。"),
  美食的魅力: L("美食的魅力", "The Charm of Food", "Charme culinaire", "料理の魅力", "飯堂捐獻可以給營地提供30點科技，一天最多300點。", "Canteen donations grant the camp 30 Technology points each, up to 300 per day.", "Les dons à la cantine rapportent 30 points technologiques au camp, jusqu’à 300 par jour.", "食堂への寄付1回につき野営地に技術ポイントを30付与し、1日最大300ポイントまで獲得できます。"),
  雪中制甲: L("雪中製甲", "Armor in Snow", "Armure sous la neige", "雪中防具製作", "小雪或大雪時護甲店配件耗時減半", "Light or heavy snow halves armor-part production time.", "La neige légère ou forte réduit de moitié le temps des pièces d’armure.", "小雪・大雪時に防具部品の製作時間が半減します。"),
  热浪起武: L("熱浪起武", "Weapons in a Heatwave", "Armes sous la chaleur", "熱波武器製作", "熱浪天氣下武器店配件耗時減半", "Heatwaves halve weapon-part production time.", "Les vagues de chaleur réduisent de moitié le temps des pièces d’armes.", "熱波時に武器部品の製作時間が半減します。"),
  护甲订单: L("護甲訂單", "Armor Orders", "Commandes d’armure", "防具注文", "護甲店配件耗時縮減為90%", "Reduces armor-part production time to 90%.", "Réduit le temps de fabrication des pièces d’armure à 90 %.", "防具部品の製作時間を90%に短縮します。"),
  管理至上: L("管理至上", "Management First", "Gestion avant tout", "管理第一", "玩家透過中心廣場的機器每完成15個物品，營地獲得1點管理值，每天營地最多增加30點。", "Every 15 items completed by a machine in Central Square grants the camp 1 Management point, up to 30 per day.", "Chaque tranche de 15 objets terminés par une machine de la place centrale rapporte 1 point de gestion au camp, jusqu’à 30 par jour.", "中央広場の機械でアイテムを15個完成させるごとに野営地が管理値を1獲得し、1日最大30まで獲得できます。"),
  加强出口: L("加強出口", "Boost Exports", "Booster les exportations", "輸出強化", "玩家透過任意交易之城成功售出1件護甲或武器時，自己的營地獲得50點科技並額外獲得5點管理值，每天營地總上限1000點。", "When a player successfully sells 1 armor or weapon item in any Trade City, their camp gains 50 Technology points and 5 extra Management points, up to a daily camp-wide limit of 1,000 points.", "Lorsqu’un joueur vend avec succès une armure ou une arme dans n’importe quelle Cité du commerce, son camp reçoit 50 points technologiques et 5 points de gestion supplémentaires, dans la limite quotidienne de 1 000 points pour le camp.", "任意の交易都市で防具または武器を1個売却すると、自分の野営地が技術ポイントを50、管理値を5追加で獲得します。野営地全体の1日の上限は1000ポイントです。"),
  武装订单: L("武裝訂單", "Weapon Orders", "Commandes d’armes", "武器注文", "武器店配件耗時縮減為90%", "Reduces weapon-part production time to 90%.", "Réduit le temps de fabrication des pièces d’armes à 90 %.", "武器部品の製作時間を90%に短縮します。"),
  远星暴走族: L("遠星暴走族", "Farstar Riders", "Pilotes de Farstar", "遠星ライダー", "在遠星城乘坐載具射擊時，對玩家造成的傷害增加5%。", "In Farstar City, damage dealt to players while firing from a vehicle increases by 5%.", "À Farstar, les dégâts infligés aux joueurs en tirant depuis un véhicule augmentent de 5 %.", "遠星城で乗り物に乗って射撃する際、プレイヤーへのダメージが5%増加します。"),
  护甲保险: L("護甲保險", "Armor Insurance", "Assurance d’armure", "防具保険", "在感染者入侵和圍剿特殊感染體玩法中，防具耐久消耗降低90%。", "Armor durability loss is reduced by 90% during Infected Invasion and Special Infected Hunt activities.", "L’usure des armures est réduite de 90 % pendant les activités Invasion des infectés et Chasse aux infectés spéciaux.", "感染者侵入および特殊感染体討伐で、防具の耐久消耗が90%減少します。"),
  家园守卫: L("家園守衛", "Homeland Guard", "Garde du foyer", "故郷の守護", "在營地內對其他營地玩家造成的傷害提升2%。", "Increases damage dealt to players from other camps by 2% while inside your camp.", "Augmente de 2 % les dégâts infligés aux joueurs des autres camps dans votre camp.", "野営地内で他の野営地のプレイヤーに与えるダメージが2%増加します。"),
  移动守卫: L("移動守衛", "Mobile Guards", "Gardes mobiles", "移動衛兵", "在已開啟的領土上，會增加一支來回巡邏的衛兵。", "Adds a guard that patrols back and forth on unlocked territory.", "Ajoute un garde qui patrouille sur les territoires débloqués.", "解放済みの領地に、往復巡回する衛兵が1人追加されます。"),
  擂台之星: L("擂台之星", "Arena Star", "Étoile de l’arène", "闘技場の星", "和貞德聊天，她會讓你在進入營地擂台時獲得強化祝福，額外增加2點攻擊力和1點護甲。", "Talk to Jeanne to receive an enhanced blessing when entering the camp arena, granting 2 extra Attack and 1 extra Armor.", "Parlez à Jeanne pour recevoir une bénédiction renforcée à l’entrée de l’arène du camp : +2 en attaque et +1 en armure.", "ジャンヌと会話すると、野営地闘技場に入る際に強化祝福を受け、攻撃力が2、装甲が1追加されます。"),
  致远星城: L("致遠星城", "To Farstar City", "Vers Farstar", "遠星城へ", "和貞德聊天，她會讓你在進入遠星城時獲得強化祝福，受到玩家傷害降低3%。", "Talk to Jeanne to receive an enhanced blessing when entering Farstar City, reducing damage received from players by 3%.", "Parlez à Jeanne pour recevoir une bénédiction renforcée à l’entrée de Farstar : les dégâts subis des joueurs sont réduits de 3 %.", "ジャンヌと会話すると、遠星城に入る際に強化祝福を受け、プレイヤーから受けるダメージが3%減少します。"),
  强袭夏尔镇: L("強襲夏爾鎮", "Assault Charles Town", "Assaut de Charles Town", "シャルルタウン強襲", "和貞德聊天，她會讓你在進入夏爾鎮時獲得強化祝福，對玩家造成的傷害增加3%。", "Talk to Jeanne to receive an enhanced blessing when entering Charles Town, increasing damage dealt to players by 3%.", "Parlez à Jeanne pour recevoir une bénédiction renforcée à l’entrée de Charles Town, qui augmente de 3 % les dégâts infligés aux joueurs.", "ジャンヌと会話すると、シャルルタウンに入る際に強化祝福を受け、プレイヤーに与えるダメージが3%増加します。"),
  游走动荡之城: L("遊走動盪之城", "Roam Turbulent City", "Errance en ville agitée", "動乱の街を巡る", "和貞德聊天，她會讓你在進入動盪之城時獲得強化祝福，受到玩家傷害降低3%。", "Talk to Jeanne to receive an enhanced blessing when entering Turbulent City, reducing damage received from players by 3%.", "Parlez à Jeanne pour recevoir une bénédiction renforcée à l’entrée de la Ville agitée : les dégâts subis des joueurs sont réduits de 3 %.", "ジャンヌと会話すると、動乱の街に入る際に強化祝福を受け、プレイヤーから受けるダメージが3%減少します。"),
  "快速装填（赤色瓶子）": L("快速裝填（赤色瓶子）", "Quick Fill (Red Bottle)", "Remplissage rapide (Fiole rouge)", "高速充填（赤い瓶）", "阿傑爾的製作速度加快", "Ajer works faster.", "Ajer travaille plus rapidement.", "アジェールの作業速度が上がります。"),
  "红绿瓶子（赤色瓶子）": L("紅綠瓶子（赤色瓶子）", "Red and Green Bottles (Red Bottle)", "Fioles rouge et verte", "赤と緑の瓶（赤い瓶）", "阿傑爾不時提供綠瓶泰坦素", "Ajer occasionally provides green-bottle Titan serum.", "Ajer fournit parfois du sérum Titan en fiole verte.", "アジェールが時々緑瓶タイタン素を提供します。"),
  赤色瓶子: L("赤色瓶子", "Red Bottle", "Fiole rouge", "赤い瓶", "阿傑爾為營地和個人提供紅瓶泰坦素", "Ajer provides red-bottle Titan serum to the camp and individuals.", "Ajer fournit du sérum Titan rouge au camp et aux membres.", "アジェールが野営地と個人に赤瓶タイタン素を提供します。"),
  弱化感染者: L("弱化感染者", "Weaken Infected", "Affaiblir les infectés", "感染者弱体化", "在感染者入侵活動中，被吸引前來的感染者比一般虛弱5%。", "In Infected Invasion, infected drawn to the camp are 5% weaker than usual.", "Pendant l’Invasion des infectés, les infectés attirés sont 5 % plus faibles que la normale.", "感染者侵入イベントでは、引き寄せられてきた感染者が通常より5%弱くなります。"),
  危险巡逻员: L("危險巡邏員", "Danger Patrol", "Patrouille dangereuse", "危険パトロール", "每位完成巡邏的巡邏員都能為營地帶來50點繁榮度，最多可獲得500點。", "Each completed patrol grants the camp 50 Prosperity, up to 500 total.", "Chaque patrouille terminée rapporte 50 points de prospérité au camp, jusqu’à 500 au total.", "巡回任務を1回完了するごとに野営地は繁栄度を50獲得し、最大500まで獲得できます。"),
  阻挡入侵: L("阻擋入侵", "Repel Intruders", "Repousser l’invasion", "侵入阻止", "在營地內每送回3名外部玩家，可獲得2點管理值，最多10點。", "For every 3 outside players sent home from inside the camp, gain 2 Management points, up to 10.", "Dans le camp, renvoyer 3 joueurs extérieurs rapporte 2 points de gestion, jusqu’à 10 au total.", "野営地内で外部プレイヤーを3人送り返すごとに管理値を2獲得し、最大10まで獲得できます。"),
  不死士兵: L("不死士兵", "Undying Soldiers", "Soldats immortels", "不死の兵士", "野營地衛兵被擊倒後的重生時間減少50%。", "Reduces camp guards’ respawn time by 50% after they are knocked down.", "Réduit de 50 % le délai de réapparition des gardes du camp après leur mise à terre.", "野営地の衛兵が倒された後の復活時間が50%短縮されます。"),
  安全与繁荣: L("安全與繁榮", "Safety and Prosperity", "Sécurité et prospérité", "安全と繁栄", "安全防衛戰中防守成功可獲得10點繁榮度，每天最多可獲得100點。", "Successfully defending in Security Defense grants 10 Prosperity, up to 100 per day.", "Une défense réussie lors de la Défense de sécurité rapporte 10 points de prospérité, jusqu’à 100 par jour.", "安全防衛戦で防衛に成功すると繁栄度を10獲得し、1日最大100まで獲得できます。"),
  大哥的视觉: L("大哥的視覺", "Big Brother’s Vision", "Vision du grand frère", "兄貴の視界", "當其他營地的玩家進入營地時，該玩家的座標每30秒會在地圖上顯示5秒。", "When a player from another camp enters your camp, their coordinates appear on the map for 5 seconds every 30 seconds.", "Lorsqu’un joueur d’un autre camp entre dans le vôtre, ses coordonnées apparaissent sur la carte pendant 5 secondes toutes les 30 secondes.", "他の野営地のプレイヤーが野営地に入ると、その座標が30秒ごとに5秒間マップに表示されます。"),
  恐怖宠物: L("恐怖寵物", "Fearsome Pets", "Animaux terrifiants", "恐怖のペット", "寵物昏迷後恢復速度提升至200%", "A pet's recovery speed after being incapacitated increases to 200%.", "La vitesse de récupération d’un familier après son évanouissement passe à 200 %.", "ペットが気絶した後の回復速度が200%になります。")
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
