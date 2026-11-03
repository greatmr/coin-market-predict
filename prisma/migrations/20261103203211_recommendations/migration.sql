-- AlterTable
ALTER TABLE "ScreeningResult" ADD COLUMN     "pumpChance" TEXT NOT NULL DEFAULT 'low',
ADD COLUMN     "pumpReasons" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Signal" ADD COLUMN     "agentRecommendation" TEXT,
ADD COLUMN     "agentRecommendationReason" TEXT,
ADD COLUMN     "pumpChance" TEXT,
ADD COLUMN     "recommendation" TEXT,
ADD COLUMN     "recommendationReason" TEXT;
