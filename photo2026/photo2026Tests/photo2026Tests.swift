//
//  photo2026Tests.swift
//  photo2026Tests
//
//  Created by yurin on 2026/04/07.
//

import Foundation
import Testing
import CoreGraphics
@testable import photo2026

struct photo2026Tests {

    @Test func centeredCropMaintainsThreeByFourPixelAspect() {
        let imageSizes = [
            CGSize(width: 4032, height: 3024),
            CGSize(width: 3024, height: 4032),
            CGSize(width: 2000, height: 4000),
        ]

        for imageSize in imageSizes {
            let crop = CropRect.centered(for: imageSize)
            let pixelWidth = crop.width * Double(imageSize.width)
            let pixelHeight = crop.height * Double(imageSize.height)
            #expect(abs(pixelWidth / pixelHeight - 3.0 / 4.0) < 0.000_001)
        }
    }

    @Test func constrainedCropStaysInsideImage() {
        let crop = CropRect(x: -0.2, y: 0.8, width: 0.7, height: 0.5).constrained()

        #expect(crop.x >= 0)
        #expect(crop.y >= 0)
        #expect(crop.x + crop.width <= 1)
        #expect(crop.y + crop.height <= 1)
    }

    @Test func progressiveGuidanceDecodesCandidateAndCompletion() throws {
        let data = Data(#"{"analysisId":"a2","captureSequence":2,"guideId":"g","subjectGuidance":[{"type":"pose","message":"左肘を画面の上へ","candidateId":"subject:pose:leftElbow","targetRole":"subject","category":"pose","target":"leftElbow","direction":"up","errorMagnitude":0.4,"priorityScore":1.6,"isResolved":false}],"guidanceProgress":[{"targetRole":"subject","wasSelected":true,"newlyResolved":true}]}"#.utf8)
        let result = try JSONDecoder().decode(RoleGuidanceUpdate.self, from: data)
        #expect(result.subjectGuidance.first?.candidateId == "subject:pose:leftElbow")
        #expect(result.subjectGuidance.first?.priorityScore == 1.6)
        #expect(result.guidanceProgress?.first?.newlyResolved == true)
        #expect(result.photographerGuidance.isEmpty)
    }

    @Test func legacyGuidanceStillDecodes() throws {
        let result = try JSONDecoder().decode(RoleGuidanceUpdate.self, from: Data(#"{"subjectGuidance":[{"type":"adjust_pose","message":"姿勢を調整"}]}"#.utf8))
        #expect(result.subjectGuidance.first?.candidateId == nil)
        #expect(result.guidanceProgress == nil)
    }

    @Test func participantWaitingSnapshotDecodesWithoutPartnerAnswers() throws {
        let data = Data(#"{"sessionId":"s","trialId":"t","revision":3,"experimentPhase":"photoEvaluation","viewPhase":"waitingForPartnerEvaluation","isPractice":true,"trialIndex":0,"totalTrials":6,"captureCount":1,"maximumCaptureCount":5,"isLastCapture":false,"currentCaptureSequence":1,"referenceImageUrl":"/ref.jpg","guideUrl":"/guide.png","photoUrl":"/photo.jpg","acknowledged":false,"submittedEvaluation":true,"questionnaireSubmitted":false,"guidance":[],"questions":[],"freeTextQuestion":"コメント"}"#.utf8)
        let state = try JSONDecoder().decode(ParticipantSnapshot.self, from: data)
        #expect(state.viewPhase == "waitingForPartnerEvaluation")
        #expect(state.submittedEvaluation)
        #expect(state.guidance.isEmpty)
        #expect(state.formKey == "s:t:1:waitingForPartnerEvaluation")
    }

    @Test func participantResetRemovesAllResumeAndDraftKeys() {
        let name = "ParticipantResetTest-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let keys = ["ParticipantFlowSession", "ParticipantFlowToken", "ParticipantStartKey:P03", "ParticipantAnswerDraft:old:trial:1:photoEvaluation"]
        for key in keys { defaults.set("old", forKey: key) }
        defaults.set("keep", forKey: "API_BASE_URL")
        ParticipantLocalState.clear(defaults)
        for key in keys { #expect(defaults.object(forKey: key) == nil) }
        #expect(defaults.string(forKey: "API_BASE_URL") == "keep")
    }

}
