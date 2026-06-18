// Reusable KVK import engine — the exact logic from _katihar_import.js, parameterized so
// a web request (not just a CLI) can run it. No module-level mutable globals: everything
// flows through a per-call context, so concurrent requests can't clobber each other.
//
// Public API:
//   previewImport({ prisma, data })            -> maps + validates, NO writes, NO kvkId needed.
//   commitImport({ prisma, data, kvkId })      -> dedup-guarded inserts for ONE kvkId.
// Both return a structured report (per-form counts + unmapped sheets + row-level failures).

const R = (name) => require('../../repositories/forms/' + name + 'Repository.js');

// ---------- pure helpers (no state) ----------
const S = (v) => String(v == null ? '' : v).trim();
const toRYDate = (v) => { const m = S(v).match(/(20\d{2})/); return `${m ? m[1] : '2025'}-01-01`; };
const toISO = (v) => { v = S(v); if (!v) return null; if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10); const m = v.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : v; };
const num = (v) => { const n = parseFloat(S(v).replace(/,/g, '')); return isFinite(n) ? n : 0; };
const _normA = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const _toksA = (s) => (String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []).map((t) => t.replace(/(ies|es|s)$/, ''));

// account-type fuzzy match: stored items must equal an accountType master option exactly
function makeMatchAccountType(ACCT_MASTER) {
  return (v) => {
    if (!v || !ACCT_MASTER.length) return v;
    const nv = _normA(v);
    const hit = ACCT_MASTER.find((o) => _normA(o) === nv);
    if (hit) return hit;
    const wt = _toksA(v); let best = null, sc = 0.7;
    for (const o of ACCT_MASTER) { const ot = _toksA(o); if (!ot.length) continue; const set = new Set(ot); let c = 0; for (const t of wt) if (set.has(t)) c++; const s = c / Math.max(wt.length, ot.length); if (s > sc) { sc = s; best = o; } }
    return best || v;
  };
}

// District Level Data: detail rows often have a blank Account Type — infer it from row content
const inferAccountType = (r) => {
  const a = String(r['Account type'] || r['Items'] || '').trim(); if (a) return a;
  if (String(r['Month'] || '').trim()) return 'Mean yearly temperature, rainfall, humidity of the district';
  const crop = String(r['Name of Crop'] || '').trim();
  if (crop && (String(r['Season'] || '').trim() || String(r['Productivity(q/ha)'] || '').trim() || String(r['Production(MT)'] || '').trim())) return 'Productivity of major 2-3 crops under cereal, pulses, oilseed, vegetables, fruits and others';
  if (crop) return 'Production of major livestock products like milk, egg, meat etc';
  return '';
};

// ---------- the form catalogue (built per-call so map/key close over the right context) ----------
// ctx = { KID, prisma, SEASON, PROJECT, AGENCY, matchAccountType }
function buildForms(ctx) {
  const { KID, prisma, SEASON, PROJECT, AGENCY, matchAccountType } = ctx;
  return [
    { sheet: 'View_Functional_linkage_wi', model: 'functionalLinkage', repo: 'functionalLinkage',
      map: (r) => ({ organizationName: S(r['Name of Organization']), natureOfLinkage: S(r['Nature of Linkage']), reportingYear: toRYDate(r['Reporting Year']) }),
      key: (d) => ({ kvkId: KID, organizationName: d.organizationName, natureOfLinkage: d.natureOfLinkage }) },

    { sheet: 'Details_of_operational_are', model: 'operationalArea', repo: 'operationalArea',
      map: (r) => ({ taluk: S(r['Taluk']), block: S(r['Block']), village: S(r['Village']), majorCrops: S(r['Major crops']), majorProblems: S(r['Major problems identified (crop-wise)']), thrustAreas: S(r['Identified Thrust Areas']), reportingYear: toRYDate(r['Reporting Year']) }),
      key: (d) => ({ kvkId: KID, village: d.village, block: d.block, majorCrops: d.majorCrops }) },

    { sheet: 'Details_of_village_adoptio', model: 'villageAdoption', repo: 'villageAdoption',
      map: (r) => ({ village: S(r['Village']), block: S(r['Block']), actionTaken: S(r['Action taken for development']), reportingYear: toRYDate(r['Reporting Year']) }),
      key: (d) => ({ kvkId: KID, village: d.village, block: d.block }) },

    { sheet: 'Priority_thrust_areas', model: 'priorityThrustArea', repo: 'priorityThrustArea',
      map: (r) => ({ thrustArea: S(r['Thrust area']), reportingYear: toRYDate(r['Reporting Year']) }),
      key: (d) => ({ kvkId: KID, thrustArea: d.thrustArea }) },

    { sheet: 'View_Details_of_KVK_Portal', model: 'webPortal', repo: 'webPortal',
      map: (r) => ({ noOfFarmersRegistered: num(r['No. of farmers registered on the portal']), noOfVisitors: num(r['No. of visitors visited the portal']), reportingYear: toRYDate(r['Reporting Year']) }),
      key: (d) => ({ kvkId: KID, reportingYear: new Date(d.reportingYear) }) },

    { sheet: 'View_Details_of_Kisan_Sara', model: 'kisanSarathi', repo: 'kisanSarathi',
      map: (r) => ({ noOfFarmersRegisteredOnKspPortal: num(r['No. of farmers registered on KSP portal']), phoneCallAddressed: num(r['Phone call addressed']), phoneCallAnswered: num(r['Answered Call'] || r['Aswered call']), crop: S(r['crop']), livestock: S(r['Livestocks']), weather: S(r['Weather']), marketing: S(r['Marketing']), awareness: S(r['Awareness']), otherEnterprises: S(r['Other Enterprises']), reportingYear: toRYDate(r['Reporting Year']) }),
      key: (d) => ({ kvkId: KID, reportingYear: new Date(d.reportingYear) }) },

    { sheet: 'View_Details_of_Mobile_App', model: 'mobileApp', repo: 'mobileApp',
      map: (r) => ({ nameOfApp: S(r['Name of the Apps']), meantFor: S(r['Meant for crop/Livestock/Fishery/Others']), numberOfAppsDeveloped: num(r['Number of Mobile Apps Developed by KVK']), languageOfApp: S(r['Language of the Apps']), numberOfTimesDownloaded: num(r['No. of Times Downloaded']), reportingYear: toRYDate(r['Reporting Year']) }),
      key: (d) => ({ kvkId: KID, reportingYear: new Date(d.reportingYear) }) },

    { sheet: 'View_Kisan_Mobile_Advisory', model: 'kmas', repo: 'kmas',
      map: (r) => ({ noOfFarmersCovered: num(r['No. of farmers covered']), noOfAdvisoriesSent: num(r['No of advisories sent']), crop: S(r['Crop']), livestock: S(r['Livestock']), weather: S(r['Weather']), marketing: S(r['Marketing']), awareness: S(r['Awareness']), otherEnterprises: S(r['Other Enterprises']), anyOther: S(r['Any Other']), reportingYear: toRYDate(r['Reporting Year']) }),
      key: (d) => ({ kvkId: KID, reportingYear: new Date(d.reportingYear), noOfFarmersCovered: d.noOfFarmersCovered, noOfAdvisoriesSent: d.noOfAdvisoriesSent }) },

    { sheet: 'View_Details_of_Entreprene', model: 'entrepreneurship', repo: 'entrepreneurship',
      map: (r) => ({ entrepreneurName: S(r['Name of the Entrepreneur/Name of the Enterprise/Firm']), registeredAddress: S(r['Registered address of the entrepreneur/firm']), yearOfEstablishment: S(r['Year of establishment']), enterpriseType: S(r['Type of Enterprise']), membersAssociated: num(r['No of Members Associated'] || r['No of members associated']), registrationDetails: S(r['Registration details']), technicalComponents: S(r['Technical Components of the Enterprise(with commodity)']), kvkRole: S(r['Role of KVK/Technology Backstopping(Quantitative Data Support)']), annualIncome: num(r['Annual Income/Revenue of the Enterprise']), developmentTimeline: S(r['Period/Timeline of the Entrepreneurship Development']), statusBeforeAfter: S(r['Economic and Social Status of Entrepreneur Before and After the Enterprise']), presentWorkingCondition: S(r['Present Working Condition of Enterprise']), majorAchievements: S(r['Major Achievements']), majorConstraints: S(r['Major constrains']), reportingYear: toRYDate(r['Reporting Year']) }),
      key: (d) => ({ kvkId: KID, entrepreneurName: d.entrepreneurName }) },

    { sheet: 'View_Resource_Generation', model: 'resourceGeneration', repo: 'resourceGeneration',
      map: (r) => ({ startDate: toISO(r['Start Date']), endDate: toISO(r['End Date']), programmeName: S(r['Name of the programme']), programmePurpose: S(r['Purpose of the programme']), sourcesOfFund: S(r['Sources of fund']), amount: num(r['Amount (Rs. lakhs)']), infrastructureCreated: S(r['Infrastructure created']) }),
      key: (d) => ({ kvkId: KID, programmeName: d.programmeName, programmePurpose: d.programmePurpose, amount: d.amount }) },

    { sheet: 'View_Revenue_Generation', model: 'revenueGeneration', repo: 'revenueGeneration',
      map: (r) => ({ startDate: toISO(r['Start Date']), endDate: toISO(r['End Date']), headName: S(r['Name of Head']), income: num(r['Income (Rs.)']), sponsoringAgency: S(r['Sponsoring agency']) }),
      key: (d) => ({ kvkId: KID, headName: d.headName, income: d.income }) },

    { sheet: 'View_Utilization_of_Hostel', model: 'hostelUtilization', repo: 'hostelUtilization',
      map: (r) => ({ months: S(r['Months']), traineesStayed: num(r['No. of Trainees Stayed']), traineeDays: num(r['Trainee Days(Days Stayed)']), reasonForShortFall: S(r['Reason for Short Fall(if any)']), reportingYear: toRYDate(r['Reporting Year']) }),
      key: (d) => ({ kvkId: KID, months: d.months, traineeDays: d.traineeDays, traineesStayed: d.traineesStayed }) },

    { sheet: 'View_Visitors', model: 'vipVisitor', repo: 'vipVisitors',
      map: (r) => { const mk = Object.keys(r).find((k) => /minister/i.test(k)); return { visitDate: toISO(r['Date of Visit']), dignitaryType: S(r['Type of Dignitaries']) || 'Other Head of Organization', ministerName: S(mk ? r[mk] : ''), observations: S(r['Salient points in his/ her observation']) }; },
      key: (d) => ({ kvkId: KID, ministerName: d.ministerName, dateOfVisit: new Date(d.visitDate) }) },

    { sheet: 'Prevalent_diseases_in_crop', model: 'prevalentDiseasesInCrop', repo: 'prevalentDiseaseCrop',
      map: (r) => ({ diseaseName: S(r['Name of the disease']), crop: S(r['Crop']), dateOfOutbreak: toISO(r['Date of outbreak']), areaAffected: num(r['Area affected (in ha)']), commodityLossPercent: num(r['% Commodity loss']), preventiveMeasuresArea: num(r['Preventive measures taken for area (in ha)']) }),
      key: (d) => ({ kvkId: KID, diseaseName: d.diseaseName, crop: d.crop }) },

    { sheet: 'Prevalent_diseases_in_live', model: 'prevalentDiseasesOnLivestock', repo: 'prevalentDiseaseLivestock',
      map: (r) => ({ diseaseName: S(r['Name of the disease']), livestockType: S(r['Species affected']), dateOfOutbreak: toISO(r['Date of outbreak']), mortalityCount: num(r['Number of death/ Morbidity rate (%)']), animalsTreated: num(r['Number of animals vaccinated']), preventiveMeasures: S(r['Preventive measures taken for area (in ha)']) }),
      key: (d) => ({ kvkId: KID, diseaseName: d.diseaseName, livestockType: d.livestockType }) },

    { sheet: 'View_Observation_of_Swachh', model: 'swachhtaHiSewa', repo: 'swachhtaBharat',
      map: (r) => ({ dateDurationOfObservation: toISO(r['Date/Duration of Observation']), totalNoOfActivitiesUndertaken: num(r['Total No of Activities undertaken']), noOfStaffs: num(r['No. Of Staffs'] || r['Staffs']), noOfFarmers: num(r['No. Of Farmers'] || r['Farmers']), noOfOthers: num(r['No. Of Others'] || r['Others']) }),
      key: (d) => ({ kvkId: KID, observationDate: new Date(d.dateDurationOfObservation), staffCount: d.noOfStaffs, farmerCount: d.noOfFarmers, othersCount: d.noOfOthers }) },

    { sheet: 'View_Success_Stories_Case_', model: 'successStory', repo: 'successStory',
      map: (r) => ({ farmerName: S(r['Name of the Farmer/Entrepreneur']), dateOfBirth: toISO(r['Date of Birth']), education: S(r['Education']), experience: S(r['Farming Experience/Experience in Enterprise']), contact: S(r['Cell no./E-mail']), fullAddress: S(r['Full Address']), professionalMembership: S(r['Professional Membership']), awardsReceived: S(r['Awards Received']), majorAchievement: S(r['Major Achievement of the Farmers']), storyTitle: S(r['Title of the Success Story/Case Study']), problemStatement: S(r['Situation Analysis/Problem Statement']), kvkIntervention: S(r['Plan, Implement and Support/KVK Intervention(s)']), practicesFollowed: S(r['Details of Practices Followed by the Farmer']), results: S(r['Results/Output(Economical/Social/ etc.)']), impact: S(r['Impact/Outcome']), futurePlans: S(r['Future Plans']), enterprise: S(r['Enterprise']), grossIncome: num(r['Gross Income(annual)']), netIncome: num(r['Net income']), costBenefitRatio: num(r['Cost-Benefit Ratio']), reportingYear: toRYDate(r['Reporting Year']) }),
      key: (d) => ({ kvkId: KID, farmerName: d.farmerName }) },

    { sheet: 'View_Performance_of_Demons', model: 'demonstrationUnit', repo: 'demonstrationUnit',
      map: (r) => ({ demoUnitName: S(r['Name of Demo Unit']), yearOfEstablishment: S(r['Year of estt.']), area: num(r['Area(Sq. mt)']), varietyBreed: S(r['Variety/Breed']), produce: S(r['Produce']), quantity: num(r['Qty.']), costOfInputs: num(r['Cost of Inputs']), grossIncome: num(r['Gross Income']), remarks: S(r['Remarks']), reportingYear: toRYDate(r['Reporting Year']) }),
      key: (d) => ({ kvkId: KID, demoUnitName: d.demoUnitName }) },

    { sheet: 'View_Performance_of_Produc', model: 'productionUnit', repo: 'productionUnit',
      filter: (r) => { const n = S(r['Name of the Product']); return n && n !== '0'; },
      map: (r) => ({ productName: S(r['Name of the Product']), quantity: num(r['Qty.(Kg)'] || r['Qty']), costOfInputs: num(r['Cost of Inputs']), grossIncome: num(r['Gross Income']), remarks: S(r['Remarks']), reportingYear: toRYDate(r['Reporting Year']) }),
      key: (d) => ({ kvkId: KID, productName: d.productName }) },

    { sheet: 'View_Revolving_Fund_Status', model: 'revolvingFund', repo: 'revolvingFund',
      map: (r) => ({ openingBalance: num(r['Opening balance as on 1st April']), incomeDuringYear: num(r['Income during the year']), expenditureDuringYear: num(r['Expenditure during the year']), kind: S(r['Kind']), reportingYear: toRYDate(r['Reporting Year']) }),
      key: (d) => ({ kvkId: KID, reportingYear: new Date(d.reportingYear) }) },

    { sheet: 'District_level_data_on_agr', model: 'districtLevelData', repo: 'districtLevelData',
      map: (r) => { const items = matchAccountType(inferAccountType(r)); const isLive = /livestock/i.test(items); const crop = S(r['Name of Crop']); const area = num(r['Area (ha)'] || r['Area(ha)']); return { items, information: S(r['Information']), season: S(r['Season']), type: S(r['Type']), cropName: isLive ? '' : crop, area: isLive ? 0 : area, production: num(r['Production(MT)']), productivity: num(r['Productivity(q/ha)']), month: S(r['Month']), rainfall: num(r['Rainfall(mm)']), maxTemp: num(r['Max. Tem.(0C)']), minTemp: num(r['Min. Tem.(0C)']), maxRH: num(r['Max. R.H.(%)']), minRH: num(r['Min. R.H.(%)']), livestockName: isLive ? crop : S(r['Name of Livestock']), number: isLive ? area : num(r['Number']), reportingYear: toRYDate(r['Reporting Year']) }; },
      key: (d) => ({ kvkId: KID, items: d.items, cropName: d.cropName, season: d.season, month: d.month, livestockName: d.livestockName }),
      warn: (d, r) => { const raw = inferAccountType(r); const out = []; if (raw && d.items && _normA(raw) !== _normA(d.items)) out.push(`Account type "${raw}" auto-matched to "${d.items}"`); if (!d.items) out.push('Account type could not be determined — left blank'); return out; } },

    { sheet: 'View_Details_of_other_meet', model: 'atariMeeting',
      direct: (d) => prisma.atariMeeting.create({ data: { kvkId: KID, meetingDate: new Date(d.meetingDate), typeOfMeeting: d.typeOfMeeting, agenda: d.agenda, representativeFromAtari: d.representativeFromAtari, reportingYear: new Date(d.reportingYear) } }),
      map: (r) => ({ meetingDate: toISO(r['Meeting Date'] || r['Date']), typeOfMeeting: S(r['Type of Meeting']), agenda: S(r['Agenda']), representativeFromAtari: S(r['Representative from ATARI'] || r['Representative From Atari']), reportingYear: toRYDate(r['Reporting Year']) }),
      key: (d) => ({ kvkId: KID, agenda: d.agenda, meetingDate: new Date(d.meetingDate) }) },

    // SAC Meetings — metadata only (file field stored empty; actual file upload is a separate step)
    { sheet: 'View_Details_of_Scientific', model: 'sacMeeting', repo: 'meetings', repoKey: 'sac',
      map: (r) => ({ startDate: toISO(r['Start Date']), endDate: toISO(r['End Date']), numberOfParticipants: num(r['No of Participants']), statutoryMembersPresent: num(r['Total Statutory Members Present(Sate Line Department)']), salientRecommendations: S(r['Salient Recommendations']), actionTaken: S(r['Action Taken']).toUpperCase() === 'YES' ? 'YES' : 'NO', reason: S(r['Reason']), uploadedFile: '' }),
      key: (d) => ({ kvkId: KID, startDate: new Date(d.startDate), endDate: new Date(d.endDate), numberOfParticipants: d.numberOfParticipants, statutoryMembersPresent: d.statutoryMembersPresent, salientRecommendations: d.salientRecommendations }) },

    // RAWE/FET/FIT — metadata only (attachment stored empty)
    { sheet: 'View_RAWE_FET_FIT_Programm', model: 'raweFetFitProgramme', repo: 'raweFet',
      map: (r) => ({ attachmentType: S(r['Attachment Type']) || 'General', attachmentPath: '', startDate: toISO(r['Start Date']), endDate: toISO(r['End Date'] || r['End date']), maleStudents: num(r['No. of Male']), femaleStudents: num(r['No. of Female']) }),
      key: (d) => ({ kvkId: KID, startDate: new Date(d.startDate), endDate: new Date(d.endDate) }) },

    { sheet: 'View_Performance_of_Instru', model: 'instructionalFarmCrop', repo: 'instructionalFarmCrop',
      filter: (r) => S(r['Name Of the Crop']),
      map: (r) => ({ seasonId: SEASON[S(r['Season']).toLowerCase()] || null, cropName: S(r['Name Of the Crop']), area: num(r['Area(ha)']), variety: S(r['Variety']), typeOfProduce: S(r['Type of Produce']), quantity: num(r['Qty.(q)']), costOfInputs: num(r['Cost of Inputs']), grossIncome: num(r['Gross Income']), remarks: S(r['Remarks']), reportingYear: toRYDate(r['Reporting Year']) }),
      key: (d) => ({ kvkId: KID, cropName: d.cropName, variety: d.variety, typeOfProduce: d.typeOfProduce }),
      warn: (d, r) => { const s = S(r['Season']); return (s && s.toLowerCase() !== 'please select' && !d.seasonId) ? [`Season "${s}" not recognised — saved without a season`] : []; } },

    { sheet: 'View_Project_wise_Budget_D', model: 'projectBudget', repo: 'projectBudget',
      map: (r) => { const pn = S(r['Name of project'] || r['Project Name']); const an = S(r['Name of Funding agency'] || r['Funding Agency']); const othP = PROJECT['others']; const othA = AGENCY['others'] || AGENCY['other']; const pid = PROJECT[pn.toLowerCase()] || othP; const aid = AGENCY[an.toLowerCase()] || othA; return { startDate: toISO(r['Start Date']), endDate: toISO(r['End Date']), financialProjectId: pid, fundingAgencyId: aid, specifyProjectName: pid === othP ? (S(r['Please specify']) || pn) : null, specifyAgencyName: aid === othA ? an : null, accountNumber: S(r['Account Number']), budgetEstimate: num(r['Budget Estimate']), budgetAllocated: num(r['Budget Allocated']), budgetReleased: num(r['Budget Released']), expenditure: num(r['Expenditure']) }; },
      key: (d) => ({ kvkId: KID, accountNumber: d.accountNumber, financialProjectId: d.financialProjectId, budgetAllocated: d.budgetAllocated, specifyProjectName: d.specifyProjectName }),
      warn: (d, r) => { const out = []; const pn = S(r['Name of project'] || r['Project Name']); if (pn && pn.toLowerCase() !== 'others' && d.financialProjectId === PROJECT['others']) out.push(`Project "${pn}" not in master — saved as "Others"`); const an = S(r['Name of Funding agency'] || r['Funding Agency']); if (an && !['others', 'other'].includes(an.toLowerCase()) && d.fundingAgencyId === (AGENCY['others'] || AGENCY['other'])) out.push(`Funding agency "${an}" not in master — saved as "Others"`); return out; } },

    { sheet: 'View_Performance_of_Instru', model: 'instructionalFarmLivestock', repo: 'instructionalFarmLivestock',
      filter: (r) => { const a = S(r['Name of the Animal/Bird/Aquatics']); return a && a !== '0'; },
      map: (r) => ({ animalName: S(r['Name of the Animal/Bird/Aquatics']), speciesBreed: S(r['Species / Breed / Variety']), typeOfProduce: S(r['Type of Produce']), quantity: num(r['Qty.']), costOfInputs: num(r['Cost of Inputs']), grossIncome: num(r['Gross Income']), remarks: S(r['Remarks']), reportingYear: toRYDate(r['Reporting Year']) }),
      key: (d) => ({ kvkId: KID, animalName: d.animalName, speciesBreed: d.speciesBreed, typeOfProduce: d.typeOfProduce }) },

    { sheet: 'Impact_of_KVK_activities', model: 'kvkImpactActivity', repo: 'kvkImpactActivity',
      map: (r) => ({ specificArea: S(r['Name of Specific Area']), briefDetails: S(r['Brief Details of the Area']), farmersBenefitted: num(r['No. of Farmers Benefitted']), horizontalSpread: S(r['Horizontal Spread(in area/no.)']), adoptionPercentage: num(r['% of Adoption']), qualitativeImpact: S(r['Impact of the Technology in Subjective Terms (Qualitative)']), quantitativeImpact: S(r['Impact of the Technology in Objective Terms (Quantitative)']), incomeBefore: num(r['Before(Rs./Unit)']), incomeAfter: num(r['After(Rs./Unit)']), reportingYear: toRYDate(r['Reporting Year']) }),
      key: (d) => ({ kvkId: KID, specificArea: d.specificArea, briefDetails: d.briefDetails, reportingYear: new Date(d.reportingYear) }) },

    { sheet: 'View_Observation_of_Swacht', model: 'swachhtaPakhwada', repo: 'swachhtaBharat', repoKey: 'pakhwada',
      map: (r) => ({ dateDurationOfObservation: toISO(r['Date/Duration of Observation']), totalNoOfActivitiesUndertaken: num(r['Total No of Activities undertaken']), noOfStaffs: num(r['No. Of Staffs'] || r['Staffs']), noOfFarmers: num(r['No. Of Farmers'] || r['Farmers']), noOfOthers: num(r['No. Of Others'] || r['Others']) }),
      key: (d) => ({ kvkId: KID, observationDate: new Date(d.dateDurationOfObservation), staffCount: d.noOfStaffs, farmerCount: d.noOfFarmers, othersCount: d.noOfOthers }) },

    { sheet: 'View_Details_of_quarterly_', model: 'swachhQuarterlyExpenditure', repo: 'swachhtaBharat', repoKey: 'budget',
      filter: (r) => num(r['Vermicomposting No of village covered']) || num(r['Other No of village covered']) || num(r['Other Total Expenditure(Rs.in Lakhs)']) || num(r['Vermicomposting Total Expenditure(Rs.in Lakhs)']),
      map: (r) => ({ vermicompostingNoOfVillageCovered: num(r['Vermicomposting No of village covered']), vermicompostingTotalExpenditure: num(r['Vermicomposting Total Expenditure(Rs.in Lakhs)']), otherNoOfVillageCovered: num(r['Other No of village covered']), otherTotalExpenditure: num(r['Other Total Expenditure(Rs.in Lakhs)']), reportingYear: '2025-01-01' }),
      key: (d) => ({ kvkId: KID, vermiVillageCovered: d.vermicompostingNoOfVillageCovered, otherVillageCovered: d.otherNoOfVillageCovered }) },

    { sheet: 'Rain_Water_Harvesting_Micr', model: 'rainwaterHarvesting', repo: 'rainwaterHarvesting',
      map: (r) => ({ trainingProgrammes: num(r['No of training programme conducted']), demonstrations: num(r['No. of demonstrations']), plantMaterial: num(r['No. of plant material produced']), farmerVisits: num(r['Visit by the farmers (No.)']), officialVisits: num(r['Visit by the officials (No.)']), reportingYear: toRYDate(r['Reporting Year']) }),
      key: (d) => ({ kvkId: KID, reportingYear: new Date(d.reportingYear) }) },
  ];
}

// sheets handled outside the FORMS loop (main + grid pairs) and known-skips
const COMBO_SHEETS = ['View_Budget_Details', 'View_Budget_Details - Start Dat', 'View_Utilization_of_Staff_', 'View_Utilization_of_Staff_ - Da', 'View_Details_of_messages_s', 'View_Details_of_messages_s - Re'];
const KNOWN_SKIP = ['View_List_of_Special_Progr', 'Edit_Details_of_messages_s_Form'];

async function loadMasters(prisma) {
  const SEASON = {}, AGENCY = {}, PROJECT = {}, ACCT_MASTER = [];
  (await prisma.season.findMany()).forEach((s) => { SEASON[String(s.seasonName).toLowerCase()] = s.seasonId; });
  (await prisma.fundingAgency.findMany()).forEach((a) => { AGENCY[String(a.agencyName).toLowerCase()] = a.fundingAgencyId; });
  (await prisma.financialProject.findMany()).forEach((p) => { PROJECT[String(p.projectName).toLowerCase()] = p.financialProjectId; });
  try { (await prisma.accountTypeMaster.findMany()).forEach((m) => ACCT_MASTER.push(m.accountType)); } catch (e) { /* form may not exist */ }
  return { SEASON, AGENCY, PROJECT, ACCT_MASTER };
}

// resolve a usable `user` context for the repos from a kvkId (their create() reads user.kvkId etc.)
async function resolveUser(prisma, kvkId) {
  const u = await prisma.user.findFirst({ where: { kvkId }, include: { role: true } });
  if (u) return { userId: u.userId, kvkId: u.kvkId, roleName: u.role && u.role.roleName, zoneId: u.zoneId, stateId: u.stateId, districtId: u.districtId, orgId: u.orgId };
  return { userId: null, kvkId };
}

// core runner shared by preview + commit. dryRun => no writes; kvkId null => skip dedup/count.
async function _run({ prisma, data, kvkId, dryRun }) {
  const sheet = (n) => (data && data[n] && data[n].rows) ? data[n].rows : [];
  const report = { kvkId: kvkId || null, forms: [], unmappedSheets: [], totals: { inserted: 0, skipped: 0, failed: 0 } };

  const user = kvkId ? await resolveUser(prisma, kvkId) : { userId: null, kvkId: null };
  const masters = await loadMasters(prisma);
  const ctx = { KID: kvkId || null, prisma, ...masters, matchAccountType: makeMatchAccountType(masters.ACCT_MASTER) };
  const FORMS = buildForms(ctx);

  for (const f of FORMS) {
    const rows = sheet(f.sheet).filter((r) => (f.filter ? f.filter(r) : true));
    const res = { sheet: f.sheet, model: f.model, supported: true, present: (sheet(f.sheet).length > 0), inserted: 0, skipped: 0, failed: 0, failures: [], warnings: [], records: [] };

    let createFn = f.direct;
    if (!createFn) {
      let repo;
      try { repo = R(f.repo); } catch (e) { res.supported = false; res.failures.push({ reason: `repo load failed: ${e.message}` }); report.forms.push(res); continue; }
      const fn = f.repoKey ? (repo[f.repoKey] && repo[f.repoKey].create)
        : (repo.create || (repo[Object.keys(repo)[0]] && repo[Object.keys(repo)[0]].create));
      if (typeof fn !== 'function') { res.supported = false; res.failures.push({ reason: 'no create() found on repository' }); report.forms.push(res); continue; }
      createFn = (d) => fn(d, user);
    }

    let i = 0;
    for (const r of rows) {
      i++;
      try {
        const d = f.map(r);
        if (dryRun) {
          res.records.push(d);
          if (f.warn) { for (const msg of (f.warn(d, r) || [])) res.warnings.push({ row: i, msg }); }
        }
        if (kvkId) { const ex = await prisma[f.model].findFirst({ where: f.key(d) }); if (ex) { res.skipped++; continue; } }
        if (!dryRun) await createFn(d);
        res.inserted++;
      } catch (e) {
        res.failed++;
        if (res.failures.length < 8) res.failures.push({ row: i, reason: e.message });
      }
    }
    if (kvkId) { try { res.totalNow = await prisma[f.model].count({ where: { kvkId } }); } catch (e) { /* ignore */ } }
    report.totals.inserted += res.inserted; report.totals.skipped += res.skipped; report.totals.failed += res.failed;
    report.forms.push(res);
  }

  // ---- combo sheets (main + grid) ----
  await _budgetDetails({ prisma, sheet, kvkId, user, dryRun, report });
  await _staffQuarters({ prisma, sheet, kvkId, user, dryRun, report });
  await _messageChannels({ prisma, sheet, kvkId, user, dryRun, report });

  // ---- coverage: any data sheet we don't handle ----
  const handled = new Set(buildForms(ctx).map((f) => f.sheet));
  COMBO_SHEETS.forEach((s) => handled.add(s));
  report.unmappedSheets = Object.keys(data || {}).filter((s) => !handled.has(s) && !KNOWN_SKIP.includes(s) && !/ - (Re|Start Dat|Da)$/.test(s) && ((data[s] && data[s].rows) || []).length);
  report.knownSkipped = KNOWN_SKIP.filter((s) => data && data[s]);
  return report;
}

async function _budgetDetails({ prisma, sheet, kvkId, user, dryRun, report }) {
  try {
    const mains = sheet('View_Budget_Details');
    if (!mains.length) return;
    const g = sheet('View_Budget_Details - Start Dat');
    const res = { sheet: 'View_Budget_Details', model: 'budgetDetail', supported: true, present: true, inserted: 0, skipped: 0, failed: 0, failures: [], warnings: [], records: [] };
    for (let i = 0; i < mains.length; i++) {
      const m = mains[i], g0 = g[2 * i] || {}, g1 = g[2 * i + 1] || {};
      const endIso = toISO(m['End Date']);
      const startDate = toISO(g1['Start Date']) || (endIso ? `${parseInt(endIso.slice(0, 4), 10) - 1}-04-01` : '2025-04-01');
      try {
        if (kvkId) { const ex = await prisma.budgetDetail.findFirst({ where: { kvkId, startDate: new Date(startDate) } }); if (ex) { res.skipped++; continue; } }
        const rec = {
          startDate, endDate: endIso || '2025-12-31',
          salaryAllocation: num(m['Salary Allocation']), salaryExpenditure: num(m['Salary Expenditure']),
          generalMainGrantAllocation: num(m['General Main Grant Allocation']), generalMainGrantExpenditure: num(m['General Main Grant Expenditure']),
          generalTspGrantAllocation: num(g0['TSP Grant Allocation']), generalTspGrantExpenditure: num(g0['TSP Grant Expenditure']),
          generalScspGrantAllocation: num(g0['SCSP Grant Allocation']), generalScspGrantExpenditure: num(g0['SCSP Grant Expenditure']),
          capitalMainGrantAllocation: num(m['Capital Main Grant Allocation']), capitalMainGrantExpenditure: num(m['Capital Main Grant Expenditure']),
          capitalTspGrantAllocation: num(g1['TSP Grant Allocation']), capitalTspGrantExpenditure: num(g1['TSP Grant Expenditure']),
          capitalScspGrantAllocation: num(g1['SCSP Grant Allocation']), capitalScspGrantExpenditure: num(g1['SCSP Grant Expenditure']),
        };
        if (dryRun) res.records.push(rec); else await R('budgetDetail').create(rec, user);
        res.inserted++;
      } catch (e) { res.failed++; if (res.failures.length < 8) res.failures.push({ row: i + 1, reason: e.message }); }
    }
    if (kvkId) { try { res.totalNow = await prisma.budgetDetail.count({ where: { kvkId } }); } catch (e) { /* */ } }
    report.totals.inserted += res.inserted; report.totals.skipped += res.skipped; report.totals.failed += res.failed;
    report.forms.push(res);
  } catch (e) { report.forms.push({ sheet: 'View_Budget_Details', supported: true, failed: 1, failures: [{ reason: e.message }] }); }
}

async function _staffQuarters({ prisma, sheet, kvkId, user, dryRun, report }) {
  try {
    const sm = sheet('View_Utilization_of_Staff_')[0];
    if (!sm) return;
    const res = { sheet: 'View_Utilization_of_Staff_', model: 'staffQuartersUtilization', supported: true, present: true, inserted: 0, skipped: 0, failed: 0, failures: [], warnings: [], records: [] };
    if (kvkId) { const ex = await prisma.staffQuartersUtilization.findFirst({ where: { kvkId } }); if (ex) { res.skipped = 1; report.forms.push(res); return; } }
    const MO = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const sg = sheet('View_Utilization_of_Staff_ - Da');
    const gr = sg.find((r) => S(r['Date of Completion'])) || sg[0] || {};
    const occ = {}; MO.forEach((mo) => { occ[mo] = S(gr[mo]); });
    try {
      const rec = {
        dateOfCompletion: toISO(sm['Date of completion']),
        isCompleted: S(sm['Whether staff quarters have been completed']) || 'No',
        numberOfQuarters: num(sm['No. of Staff Quarters'] || sm['No.of Staff Quarters']),
        occupancyDetails: S(sm['Occupancy Details']), occupancyData: JSON.stringify(occ), remark: S(sm['Remark']),
      };
      if (dryRun) res.records.push(rec); else await R('staffQuartersUtilization').create(rec, user);
      res.inserted = 1;
    } catch (e) { res.failed = 1; res.failures.push({ reason: e.message }); }
    report.totals.inserted += res.inserted; report.totals.skipped += res.skipped; report.totals.failed += res.failed;
    report.forms.push(res);
  } catch (e) { report.forms.push({ sheet: 'View_Utilization_of_Staff_', supported: true, failed: 1, failures: [{ reason: e.message }] }); }
}

async function _messageChannels({ prisma, sheet, kvkId, user, dryRun, report }) {
  try {
    const m = sheet('View_Details_of_messages_s')[0];
    if (!m) return;
    const res = { sheet: 'View_Details_of_messages_s', model: 'msgDetails', supported: true, present: true, inserted: 0, skipped: 0, failed: 0, failures: [], warnings: [], records: [] };
    if (kvkId) { const ex = await prisma.msgDetails.findFirst({ where: { kvkId } }); if (ex) { res.skipped = 1; report.forms.push(res); return; } }
    const grid = sheet('View_Details_of_messages_s - Re');
    const chans = [
      { p: 'text', f: 'Advisories through Text messages', a: 'No. of Farmers sent Text messages' },
      { p: 'whatsapp', f: 'Advisories through WhatsApp', a: 'No. of Farmers sent WhatsApp' },
      { p: 'weather', f: 'Advisories through weather advisory bulletin', a: 'No. of Farmers sent weather advisory bulletin' },
      { p: 'social', f: 'Advisories through social media', a: 'No. of Farmers sent social media' },
    ];
    const d = { reportingYear: toRYDate(m['Reporting Year'] || '2025') };
    for (const c of chans) {
      const farmers = num(m[c.f]), adv = num(m[c.a]);
      d[c.p + 'NoOfFarmersCovered'] = farmers; d[c.p + 'NoOfAdvisoriesSent'] = adv;
      const cat = grid.find((r) => num(r['No. of farmers covered']) === farmers && num(r['No of advisories sent']) === adv) || {};
      d[c.p + 'Crop'] = S(cat['Crop']); d[c.p + 'Livestock'] = S(cat['Livestock']); d[c.p + 'Weather'] = S(cat['Weather']);
      d[c.p + 'Marketing'] = S(cat['Marketing']); d[c.p + 'Awareness'] = S(cat['Awareness']); d[c.p + 'OtherEnterprises'] = S(cat['Other Enterprises']);
    }
    try { if (dryRun) res.records.push(d); else await R('msgDetails').create(d, user); res.inserted = 1; }
    catch (e) { res.failed = 1; res.failures.push({ reason: e.message }); }
    report.totals.inserted += res.inserted; report.totals.skipped += res.skipped; report.totals.failed += res.failed;
    report.forms.push(res);
  } catch (e) { report.forms.push({ sheet: 'View_Details_of_messages_s', supported: true, failed: 1, failures: [{ reason: e.message }] }); }
}

// combo forms (no FORMS entry) — their repo + dedup so edited records can still be saved
const COMBO_COMMIT = {
  budgetDetail: { repo: 'budgetDetail', key: (d, kid) => ({ kvkId: kid, startDate: new Date(d.startDate) }) },
  staffQuartersUtilization: { repo: 'staffQuartersUtilization', key: (d, kid) => ({ kvkId: kid }) },
  msgDetails: { repo: 'msgDetails', key: (d, kid) => ({ kvkId: kid }) },
};

// commit USER-REVIEWED/EDITED records (from the preview screen) instead of re-mapping the file.
// forms: [{ model, sheet?, records: [...] }]. Inserts via the same repositories + dedup guard.
async function commitRecords({ prisma, kvkId, forms }) {
  kvkId = Number(kvkId);
  if (!kvkId) throw new Error('kvkId is required to import');
  const user = await resolveUser(prisma, kvkId);
  const masters = await loadMasters(prisma);
  const ctx = { KID: kvkId, prisma, ...masters, matchAccountType: makeMatchAccountType(masters.ACCT_MASTER) };
  const byModel = {};
  buildForms(ctx).forEach((f) => { if (!byModel[f.model]) byModel[f.model] = f; });

  const report = { kvkId, forms: [], totals: { inserted: 0, skipped: 0, failed: 0 } };
  for (const inForm of (forms || [])) {
    const model = inForm.model;
    const recs = inForm.records || [];
    const res = { sheet: inForm.sheet || model, model, inserted: 0, skipped: 0, failed: 0, failures: [] };
    const f = byModel[model];
    const combo = COMBO_COMMIT[model];

    let createFn, keyFn;
    if (f) {
      keyFn = f.key;
      if (f.direct) createFn = (d) => f.direct(d);
      else {
        let repo; try { repo = R(f.repo); } catch (e) { res.failures.push({ reason: 'repo load failed: ' + e.message }); report.forms.push(res); continue; }
        const fn = f.repoKey ? (repo[f.repoKey] && repo[f.repoKey].create) : (repo.create || (repo[Object.keys(repo)[0]] && repo[Object.keys(repo)[0]].create));
        if (typeof fn !== 'function') { res.failures.push({ reason: 'no create() on repo' }); report.forms.push(res); continue; }
        createFn = (d) => fn(d, user);
      }
    } else if (combo) {
      keyFn = (d) => combo.key(d, kvkId);
      createFn = (d) => R(combo.repo).create(d, user);
    } else {
      res.failures.push({ reason: 'unknown form: ' + model });
      report.forms.push(res); continue;
    }

    let i = 0;
    for (const d of recs) {
      i++;
      try {
        if (keyFn) { const ex = await prisma[model].findFirst({ where: keyFn(d) }); if (ex) { res.skipped++; continue; } }
        await createFn(d);
        res.inserted++;
      } catch (e) { res.failed++; if (res.failures.length < 8) res.failures.push({ row: i, reason: e.message }); }
    }
    report.totals.inserted += res.inserted; report.totals.skipped += res.skipped; report.totals.failed += res.failed;
    report.forms.push(res);
  }
  return report;
}

// ---------- public API ----------
async function previewImport({ prisma, data }) {
  return _run({ prisma, data, kvkId: null, dryRun: true });
}
async function commitImport({ prisma, data, kvkId }) {
  if (!kvkId) throw new Error('kvkId is required to commit');
  return _run({ prisma, data, kvkId: Number(kvkId), dryRun: false });
}

module.exports = { previewImport, commitImport, commitRecords, _run, buildForms, loadMasters };
