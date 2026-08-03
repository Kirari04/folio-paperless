import ExpoModulesCore

struct FolioSearchEntryRecord: Record {
  @Field var identifier: String = ""
  @Field var profileId: String = ""
  @Field var documentId: String = ""
  @Field var displayTitle: String = ""
  @Field var route: String = ""
  @Field var updatedAtEpochMs: Double = 0
}
